/**
 * A mount whose files live in a SQLite database, written through as they change: mount it at
 * /home (or anywhere) and every write is durable at the end of its event-loop turn (see the
 * contract in ./sql.ts). In Lifo Cloud the database is a Durable Object's own SQLite; in a Node
 * host, a file opened with node:sqlite. Reads come from an LRU of recently used file contents,
 * then from SQLite, so nothing has to be loaded up front: a box with 10,000 files mounts at once.
 *
 *   vfs.mount('/home', new SqliteMountProvider(nodeSqlite(new DatabaseSync('box.db'))));
 *
 * Paths given to a provider are relative to its mount ('/' is the mount itself). Symlinks are
 * stored as given and resolved by the VFS, which asks hasSymlinks()/lstat()/readlink().
 *
 * Layout (one database per box):
 *   vfs(path, parent, name, type, mode, mtime, ctime, size, data, target, chunked)
 *     files up to `chunkSize` keep their bytes in `data`; larger ones are split into chunks
 *   chunks(hash, data)              content-addressed (FNV-64 + length), shared between files
 *   file_chunks(path, seq, hash)    a large file's chunks in order
 */

import { encode, decode } from '../../../utils/encoding.js';
import { getMimeType } from '../../../utils/mime.js';
import { hashBytes } from '../../storage/BlobStore.js';
import { VFSError, ErrorCode } from '../types.js';
import type { MountProvider, Stat, Dirent, FileType } from '../types.js';
import type { SyncSql, SqlRow } from './sql.js';

const FILE = 1;
const DIR = 2;
const LINK = 3;
const TYPES: Record<number, FileType> = { [FILE]: 'file', [DIR]: 'directory', [LINK]: 'symlink' };

export interface SqliteMountOptions {
  /**
   * Files larger than this are stored in chunks of this size (default 1 MiB). Durable Object
   * SQLite caps a row at 2 MB, so keep it below that there.
   */
  chunkSize?: number;
  /** Bytes of file contents kept in memory for fast reads (default 32 MiB). */
  cacheBytes?: number;
}

interface Row {
  type: number;
  mode: number;
  mtime: number;
  ctime: number;
  size: number;
  chunked: number;
  target: string | null;
}

/** A bytes value as SQLite drivers return it (Uint8Array from node:sqlite, ArrayBuffer from DOs). */
function bytes(v: unknown): Uint8Array {
  if (v instanceof Uint8Array) return v;
  if (v instanceof ArrayBuffer) return new Uint8Array(v);
  if (v == null) return new Uint8Array(0);
  return encode(String(v));
}

function parentOf(path: string): string {
  const i = path.lastIndexOf('/');
  return i <= 0 ? '/' : path.slice(0, i);
}

function nameOf(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

/** Paths inside `dir` (exclusive): `dir/` <= p < `dir0`, since '0' follows '/' in ASCII. */
function below(dir: string): [string, string] {
  return dir === '/' ? ['/', '0'] : [dir + '/', dir + '0'];
}

/** A byte-bounded LRU of file contents, by path. */
class Lru {
  private map = new Map<string, Uint8Array>();
  private total = 0;
  constructor(private readonly max: number) {}

  get(key: string): Uint8Array | undefined {
    const v = this.map.get(key);
    if (v) {
      this.map.delete(key);
      this.map.set(key, v);
    }
    return v;
  }

  set(key: string, value: Uint8Array): void {
    this.delete(key);
    if (value.byteLength > this.max / 8) return; // one big file mustn't flush everything else
    this.map.set(key, value);
    this.total += value.byteLength;
    for (const [k, v] of this.map) {
      if (this.total <= this.max) break;
      this.map.delete(k);
      this.total -= v.byteLength;
    }
  }

  delete(key: string): void {
    const v = this.map.get(key);
    if (v) {
      this.map.delete(key);
      this.total -= v.byteLength;
    }
  }

  /** Drop `dir` and everything under it. */
  deleteTree(dir: string): void {
    const prefix = dir === '/' ? '/' : dir + '/';
    for (const key of [...this.map.keys()]) {
      if (key === dir || key.startsWith(prefix)) this.delete(key);
    }
  }
}

export class SqliteMountProvider implements MountProvider {
  private readonly chunkSize: number;
  private readonly cache: Lru;
  private links: boolean;
  private writeCaching = true;

  constructor(private readonly sql: SyncSql, opts: SqliteMountOptions = {}) {
    this.chunkSize = opts.chunkSize ?? 1024 * 1024;
    this.cache = new Lru(opts.cacheBytes ?? 32 * 1024 * 1024);
    for (const ddl of [
      `CREATE TABLE IF NOT EXISTS vfs (
         path TEXT PRIMARY KEY, parent TEXT NOT NULL, name TEXT NOT NULL, type INTEGER NOT NULL,
         mode INTEGER NOT NULL, mtime INTEGER NOT NULL, ctime INTEGER NOT NULL, size INTEGER NOT NULL,
         data BLOB, target TEXT, chunked INTEGER NOT NULL DEFAULT 0)`,
      'CREATE INDEX IF NOT EXISTS vfs_parent ON vfs (parent)',
      'CREATE TABLE IF NOT EXISTS chunks (hash TEXT PRIMARY KEY, data BLOB NOT NULL)',
      `CREATE TABLE IF NOT EXISTS file_chunks (
         path TEXT NOT NULL, seq INTEGER NOT NULL, hash TEXT NOT NULL, PRIMARY KEY (path, seq))`,
      'CREATE INDEX IF NOT EXISTS file_chunks_hash ON file_chunks (hash)',
    ]) {
      sql.exec(ddl);
    }
    if (!this.row('/')) {
      const now = Date.now();
      sql.exec(
        'INSERT INTO vfs (path, parent, name, type, mode, mtime, ctime, size) VALUES (?, ?, ?, ?, ?, ?, ?, 0)',
        '/', '', '', DIR, 0o755, now, now,
      );
    }
    this.links = this.sql.exec('SELECT 1 AS x FROM vfs WHERE type = ? LIMIT 1', LINK).toArray().length > 0;
  }

  /**
   * Whether written files also go into the read cache (default on). Turn it off for a bulk import
   * (a pushed snapshot, a restore): the files are on disk either way, and an import would otherwise
   * fill the cache with files nobody has read yet.
   */
  setWriteCaching(on: boolean): void {
    this.writeCaching = on;
  }

  /** Commit this turn's writes now (they commit at the end of the turn anyway). */
  flush(): void {
    this.sql.flush?.();
  }

  // ─── Lookups ───

  private row(path: string): Row | null {
    const r = this.sql
      .exec('SELECT type, mode, mtime, ctime, size, chunked, target FROM vfs WHERE path = ?', path)
      .toArray()[0];
    return r ? (r as unknown as Row) : null;
  }

  private need(path: string): Row {
    const r = this.row(path);
    if (!r) throw new VFSError(ErrorCode.ENOENT, `'${path}': no such file or directory`);
    return r;
  }

  /** The parent of `path` must exist and be a directory. */
  private needParentDir(path: string): void {
    const p = this.row(parentOf(path));
    if (!p) throw new VFSError(ErrorCode.ENOENT, `'${parentOf(path)}': no such file or directory`);
    if (p.type !== DIR) throw new VFSError(ErrorCode.ENOTDIR, `'${parentOf(path)}': not a directory`);
  }

  private toStat(path: string, r: Row, countChildren = true): Stat {
    const stat: Stat = {
      type: TYPES[r.type],
      // A directory's size is its entry count (as in the in-memory tree); lstat skips the count,
      // since the VFS calls it for every path component while following symlinks.
      size: r.type === DIR ? (countChildren ? this.childCount(path) : 0) : r.size,
      ctime: r.ctime,
      mtime: r.mtime,
      mode: r.mode,
    };
    if (r.type === FILE) {
      const mime = getMimeType(nameOf(path));
      if (mime) stat.mime = mime;
    }
    return stat;
  }

  private childCount(path: string): number {
    const r = this.sql.exec('SELECT count(*) AS n FROM vfs WHERE parent = ?', path).toArray()[0];
    return Number(r?.n ?? 0);
  }

  // ─── Content ───

  private readContent(path: string, r: Row): Uint8Array {
    const hit = this.cache.get(path);
    if (hit) return hit;
    let data: Uint8Array;
    if (r.chunked) {
      const parts = this.sql
        .exec(
          'SELECT c.data AS data FROM file_chunks f JOIN chunks c ON c.hash = f.hash WHERE f.path = ? ORDER BY f.seq',
          path,
        )
        .toArray()
        .map((x) => bytes(x.data));
      data = new Uint8Array(r.size);
      let at = 0;
      for (const part of parts) {
        data.set(part, at);
        at += part.byteLength;
      }
    } else {
      const x = this.sql.exec('SELECT data FROM vfs WHERE path = ?', path).toArray()[0];
      data = bytes(x?.data);
    }
    this.cache.set(path, data);
    return data;
  }

  /** Remove a file's chunk list, and chunks no file uses any more. */
  private dropChunks(path: string): void {
    const hashes = this.sql
      .exec('SELECT hash FROM file_chunks WHERE path = ?', path)
      .toArray()
      .map((x) => String(x.hash));
    if (hashes.length === 0) return;
    this.sql.exec('DELETE FROM file_chunks WHERE path = ?', path);
    for (const hash of new Set(hashes)) {
      this.sql.exec('DELETE FROM chunks WHERE hash = ? AND NOT EXISTS (SELECT 1 FROM file_chunks WHERE hash = ?)', hash, hash);
    }
  }

  /** Store `data` as `path`'s content: inline, or chunked when it's large. */
  private putContent(path: string, data: Uint8Array, mode: number, ctime: number, mtime: number): void {
    const large = data.byteLength > this.chunkSize;
    this.sql.exec(
      `INSERT INTO vfs (path, parent, name, type, mode, mtime, ctime, size, data, target, chunked)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)
       ON CONFLICT (path) DO UPDATE SET type = excluded.type, mtime = excluded.mtime, size = excluded.size,
         data = excluded.data, target = NULL, chunked = excluded.chunked`,
      path, parentOf(path), nameOf(path), FILE, mode, mtime, ctime, data.byteLength, large ? null : data, large ? 1 : 0,
    );
    if (large) {
      for (let seq = 0, at = 0; at < data.byteLength; seq++, at += this.chunkSize) {
        const part = data.subarray(at, Math.min(at + this.chunkSize, data.byteLength));
        const hash = `${hashBytes(part)}-${part.byteLength}`;
        this.sql.exec('INSERT OR IGNORE INTO chunks (hash, data) VALUES (?, ?)', hash, part);
        this.sql.exec('INSERT INTO file_chunks (path, seq, hash) VALUES (?, ?, ?)', path, seq, hash);
      }
    }
    // A copy: callers reuse their buffers, and the cache must match what was stored.
    if (this.writeCaching) this.cache.set(path, new Uint8Array(data));
    else this.cache.delete(path);
  }

  // ─── VirtualProvider ───

  exists(subpath: string): boolean {
    return this.sql.exec('SELECT 1 AS x FROM vfs WHERE path = ?', subpath).toArray().length > 0;
  }

  stat(subpath: string): Stat {
    return this.toStat(subpath, this.need(subpath));
  }

  lstat(subpath: string): Stat {
    return this.toStat(subpath, this.need(subpath), false);
  }

  readFile(subpath: string): Uint8Array {
    // Every change goes through this provider and updates the cache, so a cached file exists
    // and is a file: no query needed.
    const hit = this.cache.get(subpath);
    if (hit) return hit;
    const r = this.need(subpath);
    if (r.type === DIR) throw new VFSError(ErrorCode.EISDIR, `'${subpath}': is a directory`);
    if (r.type === LINK) throw new VFSError(ErrorCode.EINVAL, `'${subpath}': is a symbolic link`);
    return this.readContent(subpath, r);
  }

  readFileString(subpath: string): string {
    return decode(this.readFile(subpath));
  }

  readdir(subpath: string): Dirent[] {
    const r = this.need(subpath);
    if (r.type !== DIR) throw new VFSError(ErrorCode.ENOTDIR, `'${subpath}': not a directory`);
    return this.sql
      .exec('SELECT name, type FROM vfs WHERE parent = ?', subpath)
      .toArray()
      .map((x: SqlRow) => ({ name: String(x.name), type: TYPES[Number(x.type)] }));
  }

  // ─── MountProvider ───

  writeFile(subpath: string, content: string | Uint8Array): void {
    const data = typeof content === 'string' ? encode(content) : content;
    const existing = this.row(subpath);
    if (existing?.type === DIR) throw new VFSError(ErrorCode.EISDIR, `'${subpath}': is a directory`);
    if (!existing) this.needParentDir(subpath);
    if (existing?.chunked) this.dropChunks(subpath);
    const now = Date.now();
    this.putContent(subpath, data, existing && existing.type === FILE ? existing.mode : 0o644, existing?.ctime ?? now, now);
  }

  appendFile(subpath: string, content: string | Uint8Array): void {
    const data = typeof content === 'string' ? encode(content) : content;
    const r = this.row(subpath);
    if (!r) return this.writeFile(subpath, data);
    const old = this.readFile(subpath);
    const merged = new Uint8Array(old.byteLength + data.byteLength);
    merged.set(old, 0);
    merged.set(data, old.byteLength);
    if (r.chunked) this.dropChunks(subpath);
    this.putContent(subpath, merged, r.mode, r.ctime, Date.now());
  }

  unlink(subpath: string): void {
    const r = this.need(subpath);
    if (r.type === DIR) throw new VFSError(ErrorCode.EISDIR, `'${subpath}': is a directory`);
    if (r.chunked) this.dropChunks(subpath);
    this.sql.exec('DELETE FROM vfs WHERE path = ?', subpath);
    this.cache.delete(subpath);
    if (r.type === LINK) this.links = this.sql.exec('SELECT 1 AS x FROM vfs WHERE type = ? LIMIT 1', LINK).toArray().length > 0;
  }

  mkdir(subpath: string, options?: { recursive?: boolean }): void {
    const now = Date.now();
    const make = (path: string) =>
      this.sql.exec(
        'INSERT INTO vfs (path, parent, name, type, mode, mtime, ctime, size) VALUES (?, ?, ?, ?, ?, ?, ?, 0)',
        path, parentOf(path), nameOf(path), DIR, 0o755, now, now,
      );
    if (options?.recursive) {
      let path = '';
      for (const part of subpath.split('/').filter(Boolean)) {
        path += '/' + part;
        const r = this.row(path);
        if (!r) make(path);
        else if (r.type !== DIR) throw new VFSError(ErrorCode.ENOTDIR, `'${path}': not a directory`);
      }
      return;
    }
    if (this.row(subpath)) throw new VFSError(ErrorCode.EEXIST, `'${subpath}': file exists`);
    this.needParentDir(subpath);
    make(subpath);
  }

  rmdir(subpath: string): void {
    const r = this.need(subpath);
    if (r.type !== DIR) throw new VFSError(ErrorCode.ENOTDIR, `'${subpath}': not a directory`);
    if (subpath === '/') throw new VFSError(ErrorCode.EINVAL, `'/': the mount's root can't be removed`);
    if (this.childCount(subpath) > 0) throw new VFSError(ErrorCode.ENOTEMPTY, `'${subpath}': directory not empty`);
    this.sql.exec('DELETE FROM vfs WHERE path = ?', subpath);
  }

  rename(oldSubpath: string, newSubpath: string): void {
    if (oldSubpath === newSubpath) return;
    const src = this.need(oldSubpath);
    if (oldSubpath === '/' || newSubpath === '/') throw new VFSError(ErrorCode.EINVAL, `'/': the mount's root can't be moved`);
    if (src.type === DIR && newSubpath.startsWith(oldSubpath + '/')) {
      throw new VFSError(ErrorCode.EINVAL, `'${oldSubpath}': can't move a directory into itself`);
    }
    this.needParentDir(newSubpath);
    const dest = this.row(newSubpath);
    if (dest) {
      if (dest.type === DIR) {
        if (src.type !== DIR) throw new VFSError(ErrorCode.EISDIR, `'${newSubpath}': is a directory`);
        if (this.childCount(newSubpath) > 0) throw new VFSError(ErrorCode.ENOTEMPTY, `'${newSubpath}': directory not empty`);
      } else if (src.type === DIR) {
        throw new VFSError(ErrorCode.ENOTDIR, `'${newSubpath}': not a directory`);
      }
      if (dest.chunked) this.dropChunks(newSubpath);
      this.sql.exec('DELETE FROM vfs WHERE path = ?', newSubpath);
      this.cache.delete(newSubpath);
    }

    const now = Date.now();
    this.sql.exec(
      'UPDATE vfs SET path = ?, parent = ?, name = ?, mtime = ? WHERE path = ?',
      newSubpath, parentOf(newSubpath), nameOf(newSubpath), now, oldSubpath,
    );
    this.sql.exec('UPDATE file_chunks SET path = ? WHERE path = ?', newSubpath, oldSubpath);
    if (src.type === DIR) {
      // Everything under it: swap the old prefix for the new one in path and parent.
      const [lo, hi] = below(oldSubpath);
      const cut = oldSubpath.length + 1; // substr is 1-based
      this.sql.exec(
        'UPDATE vfs SET path = ? || substr(path, ?), parent = ? || substr(parent, ?) WHERE path >= ? AND path < ?',
        newSubpath, cut, newSubpath, cut, lo, hi,
      );
      this.sql.exec('UPDATE file_chunks SET path = ? || substr(path, ?) WHERE path >= ? AND path < ?', newSubpath, cut, lo, hi);
      this.cache.deleteTree(oldSubpath);
    } else {
      const hit = this.cache.get(oldSubpath);
      this.cache.delete(oldSubpath);
      if (hit) this.cache.set(newSubpath, hit);
    }
  }

  copyFile(srcSubpath: string, destSubpath: string): void {
    const src = this.need(srcSubpath);
    if (src.type === DIR) throw new VFSError(ErrorCode.EISDIR, `'${srcSubpath}': is a directory`);
    this.writeFile(destSubpath, this.readContent(srcSubpath, src));
  }

  // ─── Attributes and links ───

  chmod(subpath: string, mode: number): void {
    this.need(subpath);
    this.sql.exec('UPDATE vfs SET mode = ? WHERE path = ?', mode & 0o7777, subpath);
  }

  utimes(subpath: string, mtime: number): void {
    this.need(subpath);
    this.sql.exec('UPDATE vfs SET mtime = ? WHERE path = ?', Math.floor(mtime), subpath);
  }

  symlink(target: string, subpath: string): void {
    if (this.row(subpath)) throw new VFSError(ErrorCode.EEXIST, `'${subpath}': file exists`);
    this.needParentDir(subpath);
    const now = Date.now();
    this.sql.exec(
      'INSERT INTO vfs (path, parent, name, type, mode, mtime, ctime, size, target) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      subpath, parentOf(subpath), nameOf(subpath), LINK, 0o777, now, now, encode(target).byteLength, target,
    );
    this.links = true;
  }

  readlink(subpath: string): string {
    const r = this.need(subpath);
    if (r.type !== LINK) throw new VFSError(ErrorCode.EINVAL, `'${subpath}': not a symbolic link`);
    return r.target ?? '';
  }

  hasSymlinks(): boolean {
    return this.links;
  }

  // ─── Usage ───

  /** Bytes of file content stored (inline plus distinct chunks), for quotas and metering. */
  contentBytes(): number {
    const inline = this.sql.exec('SELECT coalesce(sum(length(data)), 0) AS n FROM vfs').toArray()[0];
    const chunked = this.sql.exec('SELECT coalesce(sum(length(data)), 0) AS n FROM chunks').toArray()[0];
    return Number(inline?.n ?? 0) + Number(chunked?.n ?? 0);
  }
}
