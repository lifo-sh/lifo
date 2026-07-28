import type { VFS } from './VFS.js';
import { createTar, parseTar, compressGzip, decompressGzip } from '../../utils/archive.js';
import type { TarEntry } from '../../utils/archive.js';
import { dirname } from '../../utils/path.js';
import { isExcluded } from './sync.js';

// Synthetic provider mounts — generated on read, never snapshotted.
const SKIP_DIRS = new Set(['/proc', '/dev']);
// Yield to the event loop every N files so a large tree (node_modules) doesn't
// freeze the UI while snapshotting/restoring.
const YIELD_EVERY = 200;
const EMPTY = new Uint8Array(0);
const yieldToEventLoop = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

/**
 * Reserved tar entry carrying session state alongside the files.
 *
 * Every VFS path starts with `/`, so a relative entry name cannot collide with a
 * real file. It exists so ONE format serves every environment: before this, the
 * CLI needed somewhere to keep `cwd`/`env`/`mountPath` and so invented a
 * different container (a zip wrapping a JSON-serialized VFS), which meant a
 * snapshot saved by the CLI could not be opened in the browser and vice versa.
 */
export const SNAPSHOT_MANIFEST_ENTRY = 'lifo-snapshot.json';

/** Session state travelling with a snapshot. All fields optional but `version`. */
export interface SnapshotMetadata {
  version: 1;
  /** ISO timestamp, stamped on export. */
  savedAt: string;
  /** Working directory to restore. */
  cwd?: string;
  /** Environment to restore. */
  env?: Record<string, string>;
  /** Host directory this box had mounted, so a restore can reuse it (CLI). */
  mountPath?: string;
  /** Version of @lifo-sh/core that wrote it, for diagnosing odd restores. */
  lifoVersion?: string;
}

export interface VfsSnapshotOptions {
  /** Path segments to skip, e.g. `['node_modules', '.git']`. */
  exclude?: string[];
  /**
   * Session state to embed. Omit for a files-only snapshot — which is exactly
   * what pre-manifest snapshots are, so they keep restoring unchanged.
   */
  metadata?: Omit<Partial<SnapshotMetadata>, 'version' | 'savedAt'>;
}

/**
 * Export a VFS as a `tar.gz` snapshot. Non-blocking: yields to the event loop
 * periodically so a big tree doesn't jank the UI. Long paths round-trip via the
 * tar writer's GNU long-name headers.
 */
export async function exportVfsSnapshot(vfs: VFS, opts: VfsSnapshotOptions = {}): Promise<Uint8Array> {
  const entries: TarEntry[] = [];
  let count = 0;

  const walk = async (absPath: string): Promise<void> => {
    if (SKIP_DIRS.has(absPath) || isExcluded(absPath, opts.exclude)) return;
    const stat = vfs.stat(absPath);
    if (stat.type === 'directory') {
      if (absPath !== '/') {
        entries.push({ path: absPath, data: EMPTY, type: 'directory', mode: stat.mode, mtime: stat.mtime });
      }
      for (const child of vfs.readdir(absPath)) {
        await walk(absPath === '/' ? `/${child.name}` : `${absPath}/${child.name}`);
      }
    } else {
      entries.push({ path: absPath, data: vfs.readFile(absPath), type: 'file', mode: stat.mode, mtime: stat.mtime });
      if (++count % YIELD_EVERY === 0) await yieldToEventLoop();
    }
  };

  await walk('/');

  // Manifest last, so a reader streaming entries has already seen the files.
  if (opts.metadata) {
    const manifest: SnapshotMetadata = {
      version: 1,
      savedAt: new Date().toISOString(),
      ...opts.metadata,
    };
    entries.push({
      path: SNAPSHOT_MANIFEST_ENTRY,
      data: new TextEncoder().encode(JSON.stringify(manifest, null, 2)),
      type: 'file',
      mode: 0o644,
      mtime: Math.floor(Date.now() / 1000),
    });
  }
  const tar = createTar(entries);
  return compressGzip(tar);
}

/**
 * Restore a VFS from a `tar.gz` snapshot. Directories first (so parents exist),
 * then files; skips writing a file over an existing directory so a restore can
 * never throw mid-way. Yields periodically to stay responsive.
 */
export async function importVfsSnapshot(vfs: VFS, data: Uint8Array): Promise<SnapshotMetadata | null> {
  const tar = await decompressGzip(data);
  const entries = parseTar(tar);
  const dirs = entries.filter((e) => e.type === 'directory');

  // The manifest is metadata, not a file to restore — without this it would be
  // written into the VFS as /lifo-snapshot.json, since the loop below prefixes
  // any relative entry with '/'.
  let metadata: SnapshotMetadata | null = null;
  const files = entries.filter((e) => {
    if (e.type !== 'file') return false;
    if (e.path === SNAPSHOT_MANIFEST_ENTRY || e.path === '/' + SNAPSHOT_MANIFEST_ENTRY) {
      try {
        metadata = JSON.parse(new TextDecoder().decode(e.data)) as SnapshotMetadata;
      } catch {
        // A corrupt manifest must not cost you the files.
      }
      return false;
    }
    return true;
  });

  for (const entry of dirs) {
    const path = entry.path.startsWith('/') ? entry.path : '/' + entry.path;
    if (!vfs.exists(path)) vfs.mkdir(path, { recursive: true });
  }

  let count = 0;
  for (const entry of files) {
    const path = entry.path.startsWith('/') ? entry.path : '/' + entry.path;
    const parent = dirname(path);
    if (parent !== '/' && !vfs.exists(parent)) vfs.mkdir(parent, { recursive: true });
    if (vfs.exists(path) && vfs.stat(path).type === 'directory') continue;
    vfs.writeFile(path, entry.data);
    if (++count % YIELD_EVERY === 0) await yieldToEventLoop();
  }

  return metadata;
}

/**
 * Read just the manifest from a snapshot archive, without touching a VFS.
 *
 * A restorer often has to make decisions BEFORE it has somewhere to restore into
 * — the CLI picks which host directory to mount based on `mountPath` — so the
 * metadata has to be readable on its own.
 */
export async function readSnapshotMetadata(data: Uint8Array): Promise<SnapshotMetadata | null> {
  const tar = await decompressGzip(data);
  for (const entry of parseTar(tar)) {
    if (entry.path === SNAPSHOT_MANIFEST_ENTRY || entry.path === '/' + SNAPSHOT_MANIFEST_ENTRY) {
      try {
        return JSON.parse(new TextDecoder().decode(entry.data)) as SnapshotMetadata;
      } catch {
        return null;
      }
    }
  }
  return null;
}
