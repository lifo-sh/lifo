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

export interface VfsSnapshotOptions {
  /** Path segments to skip, e.g. `['node_modules', '.git']`. */
  exclude?: string[];
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
  const tar = createTar(entries);
  return compressGzip(tar);
}

/**
 * Restore a VFS from a `tar.gz` snapshot. Directories first (so parents exist),
 * then files; skips writing a file over an existing directory so a restore can
 * never throw mid-way. Yields periodically to stay responsive.
 */
export async function importVfsSnapshot(vfs: VFS, data: Uint8Array): Promise<void> {
  const tar = await decompressGzip(data);
  const entries = parseTar(tar);
  const dirs = entries.filter((e) => e.type === 'directory');
  const files = entries.filter((e) => e.type === 'file');

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
}
