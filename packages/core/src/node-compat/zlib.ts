import { Buffer } from './buffer.js';
import { Transform } from './stream.js';

type ZlibCallback = (err: Error | null, result?: Buffer) => void;

async function processStream(
  data: Uint8Array,
  format: CompressionFormat,
  type: 'compress' | 'decompress',
): Promise<Buffer> {
  const stream =
    type === 'compress'
      ? new CompressionStream(format)
      : new DecompressionStream(format);

  const writer = stream.writable.getWriter();
  writer.write(data as unknown as ArrayBuffer);
  writer.close();

  const reader = stream.readable.getReader();
  const chunks: Uint8Array[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }

  let totalLength = 0;
  for (const c of chunks) totalLength += c.length;
  const result = Buffer.alloc(totalLength);
  let offset = 0;
  for (const c of chunks) {
    result.set(c, offset);
    offset += c.length;
  }
  return result;
}

function wrapAsync(format: CompressionFormat, type: 'compress' | 'decompress') {
  return function (data: Uint8Array | string, optionsOrCb: unknown, cb?: ZlibCallback): void {
    const callback = typeof optionsOrCb === 'function' ? (optionsOrCb as ZlibCallback) : cb!;
    const input = typeof data === 'string' ? new TextEncoder().encode(data) : data;
    const raw = input instanceof Buffer ? new Uint8Array(input) : input;
    processStream(raw, format, type)
      .then((result) => callback(null, result))
      .catch((err) => callback(err instanceof Error ? err : new Error(String(err))));
  };
}

export const gzip = wrapAsync('gzip', 'compress');
export const gunzip = wrapAsync('gzip', 'decompress');
export const deflate = wrapAsync('deflate', 'compress');
export const inflate = wrapAsync('deflate', 'decompress');
export const deflateRaw = wrapAsync('deflate-raw', 'compress');
export const inflateRaw = wrapAsync('deflate-raw', 'decompress');
export const unzip = wrapAsync('gzip', 'decompress');

// Sync variants are not supported in the browser
export function gzipSync(): never {
  throw new Error('zlib sync operations are not supported in Lifo');
}
export function gunzipSync(): never {
  throw new Error('zlib sync operations are not supported in Lifo');
}
export function deflateSync(): never {
  throw new Error('zlib sync operations are not supported in Lifo');
}
export function inflateSync(): never {
  throw new Error('zlib sync operations are not supported in Lifo');
}

// Class-style stream constructors. pngjs's sync-inflate (pulled in by
// @expo/image-utils via expo-splash-screen's config plugin) does
// `util.inherits(Inflate, zlib.Inflate)` and `zlib.Inflate.call(this, opts)`
// at MODULE LOAD — without these constructors the whole config-plugin chain
// fails to load ("The super constructor to inherits must not be null"),
// killing `expo start` for SDK 57 templates. These provide the internal
// fields Node's zlib streams carry (which pngjs pokes directly); actually
// pumping bytes through the native-style sync engine is not supported —
// _handle.writeSync throws a clear error if something really decompresses.
function makeZlibClass(name: string): (opts?: unknown) => void {
  const ctor = function (this: Record<string, unknown>, _opts?: unknown) {
    this._handle = {
      close: () => {},
      writeSync: () => { throw new Error(`zlib.${name}: synchronous native inflate/deflate is not supported in Lifo`); },
      write: () => { throw new Error(`zlib.${name}: native inflate/deflate is not supported in Lifo`); },
    };
    this._outBuffer = Buffer.alloc(16384);
    this._outOffset = 0;
    this._chunkSize = 16384;
    this._defaultFlushFlag = 0; // Z_NO_FLUSH
    this._finishFlushFlag = 4; // Z_FINISH
    this._writeState = new Uint32Array(2);
    this._maxLength = Infinity;
    this._hadError = false;
  } as unknown as (opts?: unknown) => void;
  (ctor as { prototype: Record<string, unknown> }).prototype._processChunk = function () {
    throw new Error(`zlib.${name}._processChunk is not supported in Lifo`);
  };
  (ctor as { prototype: Record<string, unknown> }).prototype.close = function (cb?: () => void) {
    if (cb) queueMicrotask(cb);
  };
  return ctor;
}

export const Inflate = makeZlibClass('Inflate');
export const Deflate = makeZlibClass('Deflate');
export const Gzip = makeZlibClass('Gzip');
export const Gunzip = makeZlibClass('Gunzip');
export const Unzip = makeZlibClass('Unzip');
export const InflateRaw = makeZlibClass('InflateRaw');
export const DeflateRaw = makeZlibClass('DeflateRaw');
export const BrotliCompress = makeZlibClass('BrotliCompress');
export const BrotliDecompress = makeZlibClass('BrotliDecompress');
/**
 * A streaming zlib transform (what createGunzip() and friends return), backed by the
 * platform's CompressionStream/DecompressionStream. `fs.createReadStream(f).pipe(createGunzip())`
 * and `pipeline(...)` work; PGlite loads its extension bundles this way.
 */
function zlibTransform(format: CompressionFormat, type: 'compress' | 'decompress'): Transform {
  const t = new Transform();
  const cs = type === 'compress' ? new CompressionStream(format) : new DecompressionStream(format);
  const writer = cs.writable.getWriter();
  const reader = cs.readable.getReader();
  let error: Error | null = null;
  const pump = (async () => {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      t.push(Buffer.from(value));
    }
  })().catch((err) => {
    error = err instanceof Error ? err : new Error(String(err));
    t.emit('error', error);
  });
  t._transform = (chunk, _enc, cb) => {
    const bytes = typeof chunk === 'string' ? new TextEncoder().encode(chunk) : new Uint8Array(chunk as Uint8Array);
    writer.write(bytes).catch(() => {});
    cb();
  };
  t._flush = (cb) => {
    writer.close().catch(() => {});
    pump.then(() => (error ? undefined : cb()));
  };
  return t;
}

export const createInflate = (_opts?: unknown) => zlibTransform('deflate', 'decompress');
export const createDeflate = (_opts?: unknown) => zlibTransform('deflate', 'compress');
export const createGzip = (_opts?: unknown) => zlibTransform('gzip', 'compress');
export const createGunzip = (_opts?: unknown) => zlibTransform('gzip', 'decompress');
export const createUnzip = (_opts?: unknown) => zlibTransform('gzip', 'decompress');
export const createInflateRaw = (_opts?: unknown) => zlibTransform('deflate-raw', 'decompress');
export const createDeflateRaw = (_opts?: unknown) => zlibTransform('deflate-raw', 'compress');

export const constants = {
  Z_MIN_CHUNK: 64,
  Z_NO_FLUSH: 0,
  Z_PARTIAL_FLUSH: 1,
  Z_SYNC_FLUSH: 2,
  Z_FULL_FLUSH: 3,
  Z_FINISH: 4,
  Z_OK: 0,
  Z_STREAM_END: 1,
  Z_NEED_DICT: 2,
  Z_ERRNO: -1,
  Z_STREAM_ERROR: -2,
  Z_DATA_ERROR: -3,
  Z_MEM_ERROR: -4,
  Z_BUF_ERROR: -5,
  Z_NO_COMPRESSION: 0,
  Z_BEST_SPEED: 1,
  Z_BEST_COMPRESSION: 9,
  Z_DEFAULT_COMPRESSION: -1,
};

export default {
  gzip, gunzip, deflate, inflate, deflateRaw, inflateRaw, unzip,
  gzipSync, gunzipSync, deflateSync, inflateSync, constants,
  Inflate, Deflate, Gzip, Gunzip, Unzip, InflateRaw, DeflateRaw,
  BrotliCompress, BrotliDecompress,
  createInflate, createDeflate, createGzip, createGunzip, createUnzip,
  createInflateRaw, createDeflateRaw,
  // Node's legacy top-level constant aliases (pngjs reads zlib.Z_MIN_CHUNK
  // and zlib.Z_FINISH straight off the module).
  ...constants,
};
