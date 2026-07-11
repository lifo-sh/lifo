import type { VFS } from './VFS.js';
import type { VFSWatchEvent } from './types.js';

/**
 * A single filesystem change. The building block for syncing a VFS anywhere —
 * a full dump is just an ordered list of these, and an incremental sync is a
 * stream of them. Transport-agnostic: serialize with `serializeChange` to send
 * over a BroadcastChannel, a WebSocket, or into a database row.
 */
export type VfsChange =
  | { op: 'put'; path: string; data: Uint8Array }
  | { op: 'mkdir'; path: string }
  | { op: 'delete'; path: string }
  | { op: 'rename'; from: string; to: string };

export interface SyncOptions {
  /**
   * Skip any path that contains one of these segments — e.g.
   * `['node_modules', '.git']`. Applies to dumps and to the live stream.
   */
  exclude?: string[];
  /**
   * Only sync this subtree (default `/`). Useful to sync just a project dir
   * (e.g. `/home/user/app`) instead of the whole filesystem.
   */
  root?: string;
}

// Synthetic provider mounts — generated on read, not writable, never synced.
const SYSTEM_DIRS = new Set(['/proc', '/dev']);

/** True if `path` contains any excluded path segment. */
export function isExcluded(path: string, exclude?: string[]): boolean {
  if (!exclude || exclude.length === 0) return false;
  const segments = path.split('/');
  return exclude.some((ex) => segments.includes(ex));
}

/**
 * Full dump of a VFS as an ordered change list — directories before the files
 * inside them, so `applyChanges` can replay it into an empty VFS. This is the
 * "full sync" building block; for a live sync, pair it with `watchChanges`.
 */
export function dumpChanges(vfs: VFS, opts: SyncOptions = {}): VfsChange[] {
  const out: VfsChange[] = [];
  const walk = (dir: string): void => {
    for (const entry of vfs.readdir(dir)) {
      const p = dir === '/' ? '/' + entry.name : dir + '/' + entry.name;
      if (SYSTEM_DIRS.has(p) || isExcluded(p, opts.exclude)) continue;
      if (entry.type === 'directory') {
        out.push({ op: 'mkdir', path: p });
        walk(p);
      } else {
        out.push({ op: 'put', path: p, data: vfs.readFile(p) });
      }
    }
  };
  walk(opts.root ?? '/');
  return out;
}

/** Apply one change to a VFS. Idempotent: creates parents, ignores redundant
 *  deletes, and never clobbers a directory with a file. */
export function applyChange(vfs: VFS, change: VfsChange): void {
  switch (change.op) {
    case 'mkdir':
      if (!vfs.exists(change.path)) vfs.mkdir(change.path, { recursive: true });
      break;
    case 'put': {
      const slash = change.path.lastIndexOf('/');
      const parent = slash > 0 ? change.path.slice(0, slash) : '/';
      if (parent !== '/' && !vfs.exists(parent)) vfs.mkdir(parent, { recursive: true });
      if (vfs.exists(change.path) && vfs.stat(change.path).type === 'directory') break;
      vfs.writeFile(change.path, change.data);
      break;
    }
    case 'delete':
      if (vfs.exists(change.path)) {
        if (vfs.stat(change.path).type === 'directory') vfs.rmdir(change.path);
        else vfs.unlink(change.path);
      }
      break;
    case 'rename':
      if (vfs.exists(change.from)) vfs.rename(change.from, change.to);
      break;
  }
}

/** Apply an ordered list of changes (e.g. a `dumpChanges` result). */
export function applyChanges(vfs: VFS, changes: VfsChange[]): void {
  for (const change of changes) applyChange(vfs, change);
}

/**
 * Subscribe to a VFS's mutations and emit a `VfsChange` for each — the
 * incremental sync source. Feed the changes to another VFS (`applyChange`), a
 * socket (`serializeChange`), or a per-file store. Returns an unsubscribe fn.
 */
export function watchChanges(
  vfs: VFS,
  onChange: (change: VfsChange) => void,
  opts: SyncOptions = {},
): () => void {
  const read = (path: string): Uint8Array => {
    try {
      return vfs.readFile(path);
    } catch {
      return new Uint8Array(0);
    }
  };
  const root = opts.root ?? '/';
  const inScope = (p: string) => (root === '/' || p === root || p.startsWith(root + '/')) && !SYSTEM_DIRS.has(p) && !p.startsWith('/proc/') && !p.startsWith('/dev/');
  return vfs.watch((e: VFSWatchEvent) => {
    if (!inScope(e.path) || isExcluded(e.path, opts.exclude)) return;
    switch (e.type) {
      case 'create':
        onChange(e.fileType === 'directory' ? { op: 'mkdir', path: e.path } : { op: 'put', path: e.path, data: read(e.path) });
        break;
      case 'modify':
        if (e.fileType === 'file') onChange({ op: 'put', path: e.path, data: read(e.path) });
        break;
      case 'delete':
        onChange({ op: 'delete', path: e.path });
        break;
      case 'rename':
        if (!e.oldPath) break;
        // If the source was excluded, the target looks brand-new to a peer.
        if (isExcluded(e.oldPath, opts.exclude)) {
          onChange(e.fileType === 'directory' ? { op: 'mkdir', path: e.path } : { op: 'put', path: e.path, data: read(e.path) });
        } else {
          onChange({ op: 'rename', from: e.oldPath, to: e.path });
        }
        break;
    }
  });
}

// ─── Wire encoding (transport-safe: JSON + base64 for the `put` payload) ───

function toBase64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

function fromBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Encode a change to a string safe for a BroadcastChannel / WebSocket / DB row. */
export function serializeChange(change: VfsChange): string {
  if (change.op === 'put') {
    return JSON.stringify({ op: 'put', path: change.path, data: toBase64(change.data) });
  }
  return JSON.stringify(change);
}

/** Decode a change produced by `serializeChange`. */
export function deserializeChange(message: string): VfsChange {
  const o = JSON.parse(message) as { op: string; path?: string; data?: string; from?: string; to?: string };
  if (o.op === 'put') return { op: 'put', path: o.path!, data: fromBase64(o.data!) };
  return o as VfsChange;
}
