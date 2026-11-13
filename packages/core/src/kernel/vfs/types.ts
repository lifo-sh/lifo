export type FileType = 'file' | 'directory' | 'symlink';

/** `attrib`: permissions or timestamps changed (chmod, utimes), not the content. */
export type VFSEventType = 'create' | 'modify' | 'delete' | 'rename' | 'attrib';

export interface VFSWatchEvent {
  type: VFSEventType;
  path: string;
  oldPath?: string; // only for 'rename'
  fileType: FileType;
}

export type VFSWatchListener = (event: VFSWatchEvent) => void;

export interface ChunkRef {
  hash: string;
  size: number;
}

export interface INode {
  type: FileType;
  name: string;
  data: Uint8Array;         // file content (empty for dirs; empty for chunked files)
  children: Map<string, INode>;  // dir entries (empty map for files)
  ctime: number;
  mtime: number;
  mode: number;
  mime?: string;            // MIME type (files only, auto-detected)
  blobRef?: string;         // content-hash key into BlobStore (small files)
  chunks?: ChunkRef[];      // chunk manifest for large files (>= 1MB)
  storedSize?: number;      // authoritative size when chunked (data is empty)
  target?: string;          // symlink target, as given to symlink() (type 'symlink' only)
}

export interface Stat {
  type: FileType;
  size: number;
  ctime: number;
  mtime: number;
  mode: number;
  mime?: string;
}

export interface Dirent {
  name: string;
  type: FileType;
}

export const ErrorCode = {
  ENOENT: 'ENOENT',
  EEXIST: 'EEXIST',
  ENOTDIR: 'ENOTDIR',
  EISDIR: 'EISDIR',
  ENOTEMPTY: 'ENOTEMPTY',
  EINVAL: 'EINVAL',
  ELOOP: 'ELOOP',
} as const;

export type ErrorCodeType = (typeof ErrorCode)[keyof typeof ErrorCode];

export interface VirtualProvider {
  readFile(subpath: string): Uint8Array;
  readFileString(subpath: string): string;
  writeFile?(subpath: string, content: string | Uint8Array): void;
  exists(subpath: string): boolean;
  stat(subpath: string): Stat;
  readdir(subpath: string): Dirent[];
}

export interface MountProvider extends VirtualProvider {
  writeFile(subpath: string, content: string | Uint8Array): void;
  unlink(subpath: string): void;
  mkdir(subpath: string, options?: { recursive?: boolean }): void;
  rmdir(subpath: string): void;
  rename(oldSubpath: string, newSubpath: string): void;
  copyFile(srcSubpath: string, destSubpath: string): void;

  // Optional: a provider without these keeps the old behavior (chmod and utimes are accepted and
  // ignored; symlinks can't be created on it).
  /** Append without rewriting the whole file. Without it the VFS reads, concatenates and writes. */
  appendFile?(subpath: string, content: string | Uint8Array): void;
  /** Set the permission bits (0o7777). Doesn't follow a symlink at `subpath`: the VFS resolves links first. */
  chmod?(subpath: string, mode: number): void;
  /** Set the modification time (ms since the epoch). */
  utimes?(subpath: string, mtime: number): void;
  /** Create a symlink at `subpath` whose target is `target` (stored as given; the VFS resolves it). */
  symlink?(target: string, subpath: string): void;
  /** The target of the symlink at `subpath`; EINVAL if it isn't one, ENOENT if missing. */
  readlink?(subpath: string): string;
  /** stat() without following a symlink at `subpath` (type 'symlink' for a link). */
  lstat?(subpath: string): Stat;
  /**
   * Whether this provider holds any symlink. The VFS only walks paths component by component
   * (to follow links) while some provider or the tree has one, so a provider with links must say so.
   */
  hasSymlinks?(): boolean;
}

export class VFSError extends Error {
  code: ErrorCodeType;

  constructor(code: ErrorCodeType, message: string) {
    super(`${code}: ${message}`);
    this.code = code;
    this.name = 'VFSError';
  }
}
