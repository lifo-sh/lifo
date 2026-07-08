import type { VFS } from '../kernel/vfs/index.js';
import { VFSError } from '../kernel/vfs/index.js';
import type { Stat as VfsStat } from '../kernel/vfs/types.js';
import { resolve, basename } from '../utils/path.js';
import { encode, decode } from '../utils/encoding.js';
import { Readable, Writable } from './stream.js';

function concatChunks(parts: Uint8Array[]): Uint8Array {
  let len = 0;
  for (const p of parts) len += p.length;
  const out = new Uint8Array(len);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}

/**
 * Normalize fs write data. Node's writeFile/appendFile accept a string, a
 * TypedArray, OR an (async) iterable / stream, draining the latter. create-expo-app
 * writes tar entries as `writeFile(path, streamToAsyncIterable(entry.stream()))`,
 * so without draining we'd write `undefined` (files with no content).
 */
async function drainWriteData(data: unknown): Promise<string | Uint8Array> {
  if (typeof data === 'string' || data instanceof Uint8Array) return data;
  const toBytes = (c: unknown): Uint8Array =>
    typeof c === 'string' ? new TextEncoder().encode(c)
      : c instanceof Uint8Array ? c
      : new Uint8Array(c as ArrayBuffer);
  const asAsync = data as AsyncIterable<unknown> | null;
  if (asAsync && typeof asAsync[Symbol.asyncIterator] === 'function') {
    const parts: Uint8Array[] = [];
    for await (const chunk of asAsync) parts.push(toBytes(chunk));
    return concatChunks(parts);
  }
  const asSync = data as Iterable<unknown> | null;
  if (asSync && typeof asSync[Symbol.iterator] === 'function') {
    const parts: Uint8Array[] = [];
    for (const chunk of asSync) parts.push(toBytes(chunk));
    return concatChunks(parts);
  }
  return data as Uint8Array;
}
import { EventEmitter } from './events.js';
import { Buffer } from './buffer.js';

// ─── Dirent ───

interface Dirent {
  name: string;
  path: string;
  isFile: () => boolean;
  isDirectory: () => boolean;
  isSymbolicLink: () => boolean;
  isBlockDevice: () => boolean;
  isCharacterDevice: () => boolean;
  isFIFO: () => boolean;
  isSocket: () => boolean;
}

// ─── Stat conversion ───

interface NodeStat {
  dev: number;
  ino: number;
  mode: number;
  nlink: number;
  uid: number;
  gid: number;
  rdev: number;
  size: number;
  blksize: number;
  blocks: number;
  atimeMs: number;
  mtimeMs: number;
  ctimeMs: number;
  birthtimeMs: number;
  atime: Date;
  mtime: Date;
  ctime: Date;
  birthtime: Date;
  isFile: () => boolean;
  isDirectory: () => boolean;
  isSymbolicLink: () => boolean;
  isBlockDevice: () => boolean;
  isCharacterDevice: () => boolean;
  isFIFO: () => boolean;
  isSocket: () => boolean;
}

function toNodeStat(stat: VfsStat): NodeStat {
  const isFile = stat.type === 'file';
  const isDir = stat.type === 'directory';
  return {
    dev: 0,
    ino: 0,
    mode: stat.mode,
    nlink: isDir ? 2 : 1,
    uid: 1000,
    gid: 1000,
    rdev: 0,
    size: stat.size,
    blksize: 4096,
    blocks: Math.ceil(stat.size / 512),
    atimeMs: stat.mtime,
    mtimeMs: stat.mtime,
    ctimeMs: stat.ctime,
    birthtimeMs: stat.ctime,
    atime: new Date(stat.mtime),
    mtime: new Date(stat.mtime),
    ctime: new Date(stat.ctime),
    birthtime: new Date(stat.ctime),
    isFile: () => isFile,
    isDirectory: () => isDir,
    isSymbolicLink: () => false,
    isBlockDevice: () => false,
    isCharacterDevice: () => false,
    isFIFO: () => false,
    isSocket: () => false,
  };
}

// ─── Error helpers ───

interface NodeError extends Error {
  code: string;
  errno: number;
  syscall: string;
  path: string;
}

function toNodeError(e: VFSError, syscall: string, path: string): NodeError {
  const err = new Error(e.message) as NodeError;
  err.code = e.code;
  err.errno = -2;
  err.syscall = syscall;
  err.path = path;
  err.name = 'Error';
  return err;
}

function makeEnoent(syscall: string, path: string): NodeError {
  const err = new Error(`ENOENT: no such file or directory, ${syscall} '${path}'`) as NodeError;
  err.code = 'ENOENT';
  err.errno = -2;
  err.syscall = syscall;
  err.path = path;
  return err;
}

function makeEbadf(syscall: string): NodeError {
  const err = new Error(`EBADF: bad file descriptor, ${syscall}`) as NodeError;
  err.code = 'EBADF';
  err.errno = -9;
  err.syscall = syscall;
  err.path = '';
  return err;
}

type Callback<T> = (err: NodeError | null, result?: T) => void;

function resolvePath(cwd: string, p: string | URL): string {
  const str = typeof p === 'string' ? p : p.pathname;
  return resolve(cwd, str);
}

// ─── File descriptor entry ───

interface FdEntry {
  path: string;
  position: number;
  flags: string;
  closed: boolean;
}

// ─── Open flags ───

const O_RDONLY = 0;
const O_WRONLY = 1;
const O_RDWR = 2;
const O_CREAT = 64;
const O_EXCL = 128;
const O_TRUNC = 512;
const O_APPEND = 1024;

function parseFlags(flags: string | number): number {
  if (typeof flags === 'number') return flags;
  switch (flags) {
    case 'r': return O_RDONLY;
    case 'r+': return O_RDWR;
    case 'rs': case 'sr': return O_RDONLY;
    case 'rs+': case 'sr+': return O_RDWR;
    case 'w': return O_WRONLY | O_CREAT | O_TRUNC;
    case 'wx': case 'xw': return O_WRONLY | O_CREAT | O_TRUNC | O_EXCL;
    case 'w+': return O_RDWR | O_CREAT | O_TRUNC;
    case 'wx+': case 'xw+': return O_RDWR | O_CREAT | O_TRUNC | O_EXCL;
    case 'a': return O_WRONLY | O_CREAT | O_APPEND;
    case 'ax': case 'xa': return O_WRONLY | O_CREAT | O_APPEND | O_EXCL;
    case 'a+': return O_RDWR | O_CREAT | O_APPEND;
    case 'ax+': case 'xa+': return O_RDWR | O_CREAT | O_APPEND | O_EXCL;
    default: return O_RDONLY;
  }
}

export function createFs(vfs: VFS, cwd: string) {
  // ─── File descriptor table ───

  const fdTable = new Map<number, FdEntry>();
  let nextFd = 10; // start above stdin/stdout/stderr

  function getFd(fd: number): FdEntry {
    const entry = fdTable.get(fd);
    if (!entry || entry.closed) throw makeEbadf('fd');
    return entry;
  }

  // ─── Sync API ───

  function readFileSync(path: string | URL, options?: string | { encoding?: string; flag?: string }): string | Uint8Array {
    const encoding = typeof options === 'string' ? options : options?.encoding;
    const abs = resolvePath(cwd, path);
    if (encoding) {
      return vfs.readFileString(abs);
    }
    // Return Buffer (not raw Uint8Array) so .toString() yields UTF-8 text.
    // Many packages do JSON.parse(fs.readFileSync('package.json')) without
    // encoding, expecting Buffer.toString() to return the file contents.
    const raw = vfs.readFile(abs);
    return Buffer.from(raw);
  }

  function writeFileSync(path: string | URL, data: string | Uint8Array, _options?: string | { encoding?: string }): void {
    const abs = resolvePath(cwd, path);
    vfs.writeFile(abs, data);
  }

  function appendFileSync(path: string | URL, data: string | Uint8Array): void {
    const abs = resolvePath(cwd, path);
    vfs.appendFile(abs, data);
  }

  function existsSync(path: string | URL): boolean {
    const abs = resolvePath(cwd, path);
    return vfs.exists(abs);
  }

  function statSync(path: string | URL, options?: { throwIfNoEntry?: boolean }): NodeStat | undefined {
    const abs = resolvePath(cwd, path);
    // Node's `throwIfNoEntry: false` returns undefined instead of throwing on
    // a missing path. expo's directoryExistsSync relies on this.
    if (options && options.throwIfNoEntry === false && !vfs.exists(abs)) {
      return undefined;
    }
    return toNodeStat(vfs.stat(abs));
  }

  function lstatSync(path: string | URL, options?: { throwIfNoEntry?: boolean }): NodeStat | undefined {
    return statSync(path, options);
  }

  function mkdirSync(path: string | URL, options?: { recursive?: boolean; mode?: number } | number): void {
    const abs = resolvePath(cwd, path);
    const opts = typeof options === 'number' ? {} : options;
    vfs.mkdir(abs, { recursive: opts?.recursive });
  }

  function readdirSync(path: string | URL, options?: { encoding?: string; withFileTypes?: boolean }): string[] | Dirent[] {
    const abs = resolvePath(cwd, path);
    const entries = vfs.readdir(abs);
    if (options?.withFileTypes) {
      return entries.map((e) => ({
        name: e.name,
        path: abs,
        isFile: () => e.type === 'file',
        isDirectory: () => e.type === 'directory',
        isSymbolicLink: () => false,
        isBlockDevice: () => false,
        isCharacterDevice: () => false,
        isFIFO: () => false,
        isSocket: () => false,
      }));
    }
    return entries.map((e) => e.name);
  }

  function unlinkSync(path: string | URL): void {
    const abs = resolvePath(cwd, path);
    vfs.unlink(abs);
  }

  function rmdirSync(path: string | URL, options?: { recursive?: boolean }): void {
    const abs = resolvePath(cwd, path);
    if (options?.recursive) {
      vfs.rmdirRecursive(abs);
    } else {
      vfs.rmdir(abs);
    }
  }

  function renameSync(oldPath: string | URL, newPath: string | URL): void {
    const abs1 = resolvePath(cwd, oldPath);
    const abs2 = resolvePath(cwd, newPath);
    vfs.rename(abs1, abs2);
  }

  function copyFileSync(src: string | URL, dest: string | URL): void {
    const abs1 = resolvePath(cwd, src);
    const abs2 = resolvePath(cwd, dest);
    vfs.copyFile(abs1, abs2);
  }

  function chmodSync(_path: string | URL, _mode: number): void {
    // No-op in VFS
  }

  function chownSync(_path: string | URL, _uid: number, _gid: number): void {
    // No-op in VFS
  }

  function accessSync(path: string | URL, _mode?: number): void {
    const abs = resolvePath(cwd, path);
    if (!vfs.exists(abs)) {
      throw makeEnoent('access', abs);
    }
  }

  const realpathSync = Object.assign(
    function realpathSync(path: string | URL): string {
      const abs = resolvePath(cwd, path);
      if (!vfs.exists(abs)) {
        throw makeEnoent('realpath', abs);
      }
      return abs;
    },
    {
      native: function realpathSyncNative(path: string | URL): string {
        const abs = resolvePath(cwd, path);
        if (!vfs.exists(abs)) {
          throw makeEnoent('realpath', abs);
        }
        return abs;
      },
    },
  );

  function truncateSync(path: string | URL, len?: number): void {
    const abs = resolvePath(cwd, path);
    const data = vfs.readFile(abs);
    const newLen = len ?? 0;
    if (newLen >= data.length) return;
    vfs.writeFile(abs, data.slice(0, newLen));
  }

  // ─── File descriptor sync API ───
  // NOTE: File descriptor operations work with mounted native filesystems via VFS
  // delegation. The fd table maps fds to VFS paths. When operations like readSync/
  // writeSync call vfs.readFile()/vfs.writeFile() on those paths, the VFS mount system
  // automatically delegates to the appropriate provider (e.g. NativeFsProvider).

  function openSync(path: string | URL, flags?: string | number, _mode?: number): number {
    const abs = resolvePath(cwd, path);
    const numFlags = parseFlags(flags ?? 'r');

    if (numFlags & O_CREAT) {
      if (vfs.exists(abs)) {
        if (numFlags & O_EXCL) {
          const err = new Error(`EEXIST: file already exists, open '${abs}'`) as NodeJS.ErrnoException;
          err.code = 'EEXIST';
          err.errno = -17;
          err.path = abs;
          throw err;
        }
      } else {
        vfs.writeFile(abs, '');
      }
    }

    if (numFlags & O_TRUNC) {
      vfs.writeFile(abs, '');
    }

    if (!vfs.exists(abs)) {
      throw makeEnoent('open', abs);
    }

    const fd = nextFd++;
    fdTable.set(fd, {
      path: abs,
      position: (numFlags & O_APPEND) ? vfs.readFile(abs).length : 0,
      flags: typeof flags === 'string' ? flags : 'r',
      closed: false,
    });
    return fd;
  }

  function closeSync(fd: number): void {
    const entry = getFd(fd);
    entry.closed = true;
    fdTable.delete(fd);
  }

  function readSync(fd: number, buffer: Uint8Array, offset: number, length: number, position: number | null): number {
    const entry = getFd(fd);
    const data = vfs.readFile(entry.path);
    const pos = position !== null ? position : entry.position;
    const available = Math.max(0, data.length - pos);
    const bytesToRead = Math.min(length, available);
    if (bytesToRead === 0) return 0;
    buffer.set(data.subarray(pos, pos + bytesToRead), offset);
    if (position === null) {
      entry.position = pos + bytesToRead;
    }
    return bytesToRead;
  }

  function writeSync(fd: number, bufferOrString: Uint8Array | string, offsetOrPosition?: number, lengthOrEncoding?: number | string, position?: number | null): number {
    const entry = getFd(fd);

    let data: Uint8Array;
    let pos: number;

    if (typeof bufferOrString === 'string') {
      data = encode(bufferOrString);
      pos = typeof offsetOrPosition === 'number' ? offsetOrPosition : entry.position;
    } else {
      const offset = (offsetOrPosition as number) ?? 0;
      const length = (typeof lengthOrEncoding === 'number' ? lengthOrEncoding : bufferOrString.length - offset);
      data = bufferOrString.subarray(offset, offset + length);
      pos = position !== null && position !== undefined ? position : entry.position;
    }

    const fileData = vfs.readFile(entry.path);
    const endPos = pos + data.length;
    const newSize = Math.max(fileData.length, endPos);
    const newData = new Uint8Array(newSize);
    newData.set(fileData, 0);
    newData.set(data, pos);
    vfs.writeFile(entry.path, newData);

    entry.position = endPos;
    return data.length;
  }

  function fstatSync(fd: number): NodeStat {
    const entry = getFd(fd);
    return toNodeStat(vfs.stat(entry.path));
  }

  function ftruncateSync(fd: number, len?: number): void {
    const entry = getFd(fd);
    truncateSync(entry.path, len);
  }

  function fsyncSync(_fd: number): void {
    // No-op - VFS is always in sync
  }

  function fdatasyncSync(_fd: number): void {
    // No-op
  }

  // ─── Symlink stubs ───

  function symlinkSync(_target: string, _path: string, _type?: string): void {
    // No-op - VFS has no symlink support yet
  }

  function linkSync(_existingPath: string, _newPath: string): void {
    // No-op
  }

  function readlinkSync(path: string | URL): string {
    // Return the path itself since we have no symlinks
    return resolvePath(cwd, path);
  }

  // ─── Callback API ───

  function wrapCallback<T>(syncFn: () => T, cb: Callback<T>): void {
    queueMicrotask(() => {
      try {
        const result = syncFn();
        cb(null, result);
      } catch (e) {
        if (e instanceof VFSError) {
          cb(toNodeError(e, '', ''));
        } else if ((e as NodeError).code) {
          cb(e as NodeError);
        } else {
          throw e;
        }
      }
    });
  }

  function readFile(path: string | URL, optionsOrCb: string | { encoding?: string } | Callback<string | Uint8Array>, cb?: Callback<string | Uint8Array>): void {
    const callback = typeof optionsOrCb === 'function' ? optionsOrCb : cb!;
    const options = typeof optionsOrCb === 'function' ? undefined : optionsOrCb;
    wrapCallback(() => readFileSync(path, options), callback);
  }

  function writeFile(path: string | URL, data: string | Uint8Array, optionsOrCb: string | { encoding?: string } | Callback<void>, cb?: Callback<void>): void {
    const callback = typeof optionsOrCb === 'function' ? optionsOrCb : cb!;
    wrapCallback(() => writeFileSync(path, data), callback);
  }

  function stat(path: string | URL, cb: Callback<NodeStat>): void {
    wrapCallback(() => statSync(path), cb);
  }

  function lstat(path: string | URL, cb: Callback<NodeStat>): void {
    wrapCallback(() => lstatSync(path), cb);
  }

  function mkdir(path: string | URL, optionsOrCb: { recursive?: boolean } | Callback<void>, cb?: Callback<void>): void {
    const callback = typeof optionsOrCb === 'function' ? optionsOrCb : cb!;
    const options = typeof optionsOrCb === 'function' ? undefined : optionsOrCb;
    wrapCallback(() => mkdirSync(path, options), callback);
  }

  function readdir(path: string | URL, optionsOrCb: { encoding?: string; withFileTypes?: boolean } | Callback<string[]>, cb?: Callback<string[] | Dirent[]>): void {
    const options = typeof optionsOrCb === 'function' ? undefined : optionsOrCb;
    const callback = typeof optionsOrCb === 'function' ? optionsOrCb : cb!;
    wrapCallback(() => readdirSync(path, options), callback);
  }

  function unlink(path: string | URL, cb: Callback<void>): void {
    wrapCallback(() => unlinkSync(path), cb);
  }

  function rename(oldPath: string | URL, newPath: string | URL, cb: Callback<void>): void {
    wrapCallback(() => renameSync(oldPath, newPath), cb);
  }

  function access(path: string | URL, modeOrCb: number | Callback<void>, cb?: Callback<void>): void {
    const callback = typeof modeOrCb === 'function' ? modeOrCb : cb!;
    const mode = typeof modeOrCb === 'function' ? undefined : modeOrCb;
    wrapCallback(() => accessSync(path, mode), callback);
  }

  function exists(path: string | URL, cb: (exists: boolean) => void): void {
    queueMicrotask(() => {
      cb(existsSync(path));
    });
  }

  function open(path: string | URL, flagsOrCb: string | number | Callback<number>, modeOrCb?: number | Callback<number>, cb?: Callback<number>): void {
    let callback: Callback<number>;
    let flags: string | number;
    let mode: number | undefined;

    if (typeof flagsOrCb === 'function') {
      callback = flagsOrCb;
      flags = 'r';
    } else if (typeof modeOrCb === 'function') {
      callback = modeOrCb;
      flags = flagsOrCb;
    } else {
      callback = cb!;
      flags = flagsOrCb;
      mode = modeOrCb;
    }

    wrapCallback(() => openSync(path, flags, mode), callback);
  }

  function close(fd: number, cb: Callback<void>): void {
    wrapCallback(() => closeSync(fd), cb);
  }

  function read(fd: number, buffer: Uint8Array, offset: number, length: number, position: number | null, cb: (err: Error | null, bytesRead: number, buffer: Uint8Array) => void): void {
    queueMicrotask(() => {
      try {
        const bytesRead = readSync(fd, buffer, offset, length, position);
        cb(null, bytesRead, buffer);
      } catch (e) {
        cb(e as Error, 0, buffer);
      }
    });
  }

  // fs.write(fd, buffer, offset, length, position, cb) | fs.write(fd, string[, position[, encoding]], cb)
  function write(fd: number, data: Uint8Array | string, ...rest: unknown[]): void {
    const cb = rest.find((a) => typeof a === 'function') as
      | ((err: Error | null, written: number, data: Uint8Array | string) => void)
      | undefined;
    const nums = rest.filter((a) => typeof a === 'number') as number[];
    queueMicrotask(() => {
      try {
        let written: number;
        if (typeof data === 'string') {
          // (fd, string, position?, encoding?)
          written = writeSync(fd, data, nums[0]);
        } else {
          // (fd, buffer, offset?, length?, position?)
          const [offset, length, position] = nums;
          written = writeSync(fd, data, offset, length, position ?? null);
        }
        cb?.(null, written, data);
      } catch (e) {
        cb?.(e as Error, 0, data);
      }
    });
  }

  function fstat(fd: number, cb: Callback<NodeStat>): void {
    wrapCallback(() => fstatSync(fd), cb);
  }

  const realpath = Object.assign(
    function realpath(path: string | URL, optOrCb: unknown, cb?: Callback<string>): void {
      const callback = typeof optOrCb === 'function' ? optOrCb as Callback<string> : cb!;
      wrapCallback(() => realpathSync(path), callback);
    },
    {
      native: function realpathNative(path: string | URL, optOrCb: unknown, cb?: Callback<string>): void {
        const callback = typeof optOrCb === 'function' ? optOrCb as Callback<string> : cb!;
        wrapCallback(() => realpathSync(path), callback);
      },
    },
  );

  // ─── Stream API ───

  // NOTE: createReadStream works with mounted native filesystems via VFS delegation.
  // When the path is under a NativeFsProvider mount, vfs.readFile() delegates to the
  // mount provider, which reads from the real host filesystem. The data is still buffered
  // in memory before being pushed to the stream.
  function createReadStream(path: string | URL, options?: { encoding?: string; start?: number; end?: number; highWaterMark?: number }): Readable {
    const abs = resolvePath(cwd, path);
    const stream = new Readable();

    queueMicrotask(() => {
      try {
        const data = vfs.readFile(abs);
        const start = options?.start ?? 0;
        const end = options?.end !== undefined ? options.end + 1 : data.length;
        const slice = data.subarray(start, end);

        if (options?.encoding) {
          stream.push(decode(slice));
        } else {
          // No encoding → emit raw bytes (Buffer), like Node. Decoding to a
          // string here corrupts binary files (wasm, images, fonts) served via
          // fs.createReadStream (e.g. Vite/sirv static serving).
          stream.push(Buffer.from(slice));
        }
        stream.push(null);
      } catch (e) {
        stream.emit('error', e);
      }
    });

    return stream;
  }

  // NOTE: createWriteStream works with mounted native filesystems via VFS delegation.
  // When the path is under a NativeFsProvider mount, vfs.writeFile() and vfs.appendFile()
  // delegate to the mount provider, which writes to the real host filesystem.
  function createWriteStream(path: string | URL, options?: { flags?: string; encoding?: string }): Writable {
    const abs = resolvePath(cwd, path);
    const flags = options?.flags ?? 'w';
    // Accumulate raw byte chunks so binary writes aren't corrupted by joining
    // as strings.
    const chunks: Uint8Array[] = [];
    const toBytes = (c: string | Uint8Array): Uint8Array => (typeof c === 'string' ? encode(c) : c);

    if (flags.includes('w')) {
      // Truncate on open
      try { vfs.writeFile(abs, ''); } catch { /* parent may not exist yet */ }
    }

    const stream = new Writable();

    stream.write = (chunk: string | Uint8Array, _encoding?: string, cb?: () => void): boolean => {
      try {
        if (flags.includes('a')) {
          vfs.appendFile(abs, toBytes(chunk));
        } else {
          chunks.push(toBytes(chunk));
          let total = 0;
          for (const c of chunks) total += c.length;
          const all = new Uint8Array(total);
          let off = 0;
          for (const c of chunks) { all.set(c, off); off += c.length; }
          vfs.writeFile(abs, all);
        }
      } catch (e) {
        stream.emit('error', e);
        return false;
      }
      if (cb) cb();
      return true;
    };

    stream.end = (chunk?: string | Uint8Array): void => {
      if (chunk) stream.write(chunk);
      stream.emit('finish');
      stream.emit('close');
    };

    return stream;
  }

  // ─── Watch API ───

  function watch(filename: string | URL, optionsOrListener?: { persistent?: boolean; recursive?: boolean; encoding?: string } | ((eventType: string, filename: string) => void), listener?: (eventType: string, filename: string) => void): EventEmitter {
    const abs = resolvePath(cwd, filename);
    const cb = typeof optionsOrListener === 'function' ? optionsOrListener : listener;
    const options = typeof optionsOrListener === 'object' && optionsOrListener !== null ? optionsOrListener : {};

    const watcher = new EventEmitter();

    // Scoped, per-path subscription on the VFS event bus.
    // Node semantics: eventType is 'change' (content modified) or 'rename'
    // (created / deleted / renamed); filename is relative to the watched path.
    const emit = (eventPath: string, type: string) => {
      const eventType = type === 'modify' ? 'change' : 'rename';
      let name: string;
      if (eventPath === abs) {
        name = basename(abs);
      } else {
        name = eventPath.slice(abs.length + 1);
        // Without { recursive: true }, only direct children are reported.
        if (!options.recursive && name.includes('/')) return;
      }
      if (cb) cb(eventType, name);
      watcher.emit('change', eventType, name);
    };

    const unsubscribe = vfs.watch(abs, (event) => {
      emit(event.path === abs || event.path.startsWith(abs + '/') ? event.path : event.oldPath!, event.type);
    });

    (watcher as unknown as Record<string, unknown>).close = () => {
      unsubscribe();
      watcher.emit('close');
    };

    return watcher;
  }

  // Stat-polling API (chokidar fallback) — event-driven here, no actual polling.
  const watchFileSubs = new Map<string, Map<(curr: unknown, prev: unknown) => void, () => void>>();

  function statOrZero(abs: string): ReturnType<typeof statSync> | { mtimeMs: number; size: number; ino: number; mtime: Date; ctimeMs: number; isFile(): boolean; isDirectory(): boolean } {
    try {
      return statSync(abs);
    } catch {
      return { mtimeMs: 0, size: 0, ino: 0, mtime: new Date(0), ctimeMs: 0, isFile: () => false, isDirectory: () => false };
    }
  }

  function watchFile(filename: string | URL, optionsOrListener?: { persistent?: boolean; interval?: number } | ((curr: unknown, prev: unknown) => void), listener?: (curr: unknown, prev: unknown) => void): EventEmitter {
    const abs = resolvePath(cwd, filename);
    const cb = typeof optionsOrListener === 'function' ? optionsOrListener : listener;

    // Node returns a StatWatcher (EventEmitter with ref/unref/stop). Callers
    // store it and call .unref()/.stop() — e.g. Expo's FileNotifier does
    // `watchFile(...).unref()`, which crashed when we returned undefined.
    const watcher = new EventEmitter() as EventEmitter & {
      ref: () => unknown; unref: () => unknown; stop: () => void;
    };
    watcher.ref = () => watcher;
    watcher.unref = () => watcher;

    if (!cb) { watcher.stop = () => {}; return watcher; }

    let prev = statOrZero(abs);
    const unsubscribe = vfs.watch(abs, () => {
      const curr = statOrZero(abs);
      const p = prev;
      prev = curr;
      cb(curr, p);
      watcher.emit('change', curr, p);
    });

    let subs = watchFileSubs.get(abs);
    if (!subs) {
      subs = new Map();
      watchFileSubs.set(abs, subs);
    }
    subs.set(cb, unsubscribe);

    watcher.stop = () => {
      unsubscribe();
      subs!.delete(cb);
      if (subs!.size === 0) watchFileSubs.delete(abs);
    };
    return watcher;
  }

  function unwatchFile(filename: string | URL, listener?: (curr: unknown, prev: unknown) => void): void {
    const abs = resolvePath(cwd, filename);
    const subs = watchFileSubs.get(abs);
    if (!subs) return;
    if (listener) {
      subs.get(listener)?.();
      subs.delete(listener);
    } else {
      for (const unsub of subs.values()) unsub();
      subs.clear();
    }
    if (subs.size === 0) watchFileSubs.delete(abs);
  }

  // ─── Promises API ───

  const promises = {
    readFile: async (path: string | URL, options?: string | { encoding?: string }) => readFileSync(path, options),
    writeFile: async (path: string | URL, data: unknown) => writeFileSync(path, await drainWriteData(data)),
    appendFile: async (path: string | URL, data: unknown) => appendFileSync(path, await drainWriteData(data)),
    stat: async (path: string | URL) => statSync(path),
    lstat: async (path: string | URL) => lstatSync(path),
    mkdir: async (path: string | URL, options?: { recursive?: boolean }) => { mkdirSync(path, options); },
    readdir: async (path: string | URL, options?: { encoding?: string; withFileTypes?: boolean }) => readdirSync(path, options),
    unlink: async (path: string | URL) => unlinkSync(path),
    rmdir: async (path: string | URL, options?: { recursive?: boolean }) => rmdirSync(path, options),
    rename: async (oldPath: string | URL, newPath: string | URL) => renameSync(oldPath, newPath),
    copyFile: async (src: string | URL, dest: string | URL) => copyFileSync(src, dest),
    access: async (path: string | URL, mode?: number) => accessSync(path, mode),
    realpath: async (path: string | URL) => realpathSync(path),
    truncate: async (path: string | URL, len?: number) => truncateSync(path, len),
    chmod: async (_path: string | URL, _mode: number) => {},
    chown: async (_path: string | URL, _uid: number, _gid: number) => {},
    open: async (path: string | URL, flags?: string | number, mode?: number) => {
      const fd = openSync(path, flags, mode);
      return {
        fd,
        close: async () => closeSync(fd),
        read: async (buffer: Uint8Array, offset: number, length: number, position: number | null) => ({
          bytesRead: readSync(fd, buffer, offset, length, position),
          buffer,
        }),
        write: async (data: Uint8Array | string) => ({
          bytesWritten: writeSync(fd, data),
        }),
        stat: async () => fstatSync(fd),
        truncate: async (len?: number) => ftruncateSync(fd, len),
        chmod: async (_mode: number) => {},
        chown: async (_uid: number, _gid: number) => {},
        sync: async () => {},
        datasync: async () => {},
        writeFile: async (data: Uint8Array | string) => { writeSync(fd, data); },
        readFile: async (options?: string | { encoding?: string }) => {
          const entry = getFd(fd);
          return readFileSync(entry.path, options);
        },
      };
    },
    rm: async (path: string | URL, options?: { recursive?: boolean; force?: boolean }) => {
      const abs = resolvePath(cwd, path);
      try {
        const s = vfs.stat(abs);
        if (s.type === 'directory') {
          if (options?.recursive) {
            vfs.rmdirRecursive(abs);
          } else {
            vfs.rmdir(abs);
          }
        } else {
          vfs.unlink(abs);
        }
      } catch (e) {
        if (options?.force && e instanceof VFSError && e.code === 'ENOENT') return;
        throw e;
      }
    },
  };

  // ─── Constants ───

  const constants = {
    F_OK: 0,
    R_OK: 4,
    W_OK: 2,
    X_OK: 1,
    O_RDONLY,
    O_WRONLY,
    O_RDWR,
    O_CREAT,
    O_TRUNC,
    O_APPEND,
    COPYFILE_EXCL: 1,
    COPYFILE_FICLONE: 2,
    COPYFILE_FICLONE_FORCE: 4,
  };

  return {
    // Sync
    readFileSync,
    writeFileSync,
    appendFileSync,
    existsSync,
    statSync,
    lstatSync,
    mkdirSync,
    readdirSync,
    unlinkSync,
    rmdirSync,
    renameSync,
    copyFileSync,
    chmodSync,
    chownSync,
    accessSync,
    realpathSync,
    truncateSync,
    openSync,
    closeSync,
    readSync,
    writeSync,
    fstatSync,
    ftruncateSync,
    fsyncSync,
    fdatasyncSync,
    symlinkSync,
    linkSync,
    readlinkSync,
    // Callback
    readFile,
    writeFile,
    stat,
    lstat,
    mkdir,
    readdir,
    unlink,
    rename,
    access,
    exists,
    open,
    close,
    read,
    write,
    fstat,
    realpath,
    // Streams
    createReadStream,
    createWriteStream,
    // Watch
    watch,
    watchFile,
    unwatchFile,
    // Promises
    promises,
    // Constants
    constants,
  };
}
