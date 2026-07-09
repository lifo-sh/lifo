import type { VFS } from '../kernel/vfs/index.js';
import type { CommandOutputStream } from '../commands/types.js';
import { createFs } from './fs.js';
import pathModule from './path.js';
import { createOs } from './os.js';
import { createProcess } from './process.js';
import { EventEmitter } from './events.js';
import { Buffer } from './buffer.js';
import * as utilModule from './util.js';
import { createHttp } from './http.js';
import type { VirtualRequestHandler } from '../kernel/index.js';
import { createChildProcess } from './child_process.js';
import * as streamModule from './stream.js';
import * as urlModule from './url.js';
import * as timersModule from './timers.js';
import * as cryptoModule from './crypto.js';
import * as zlibModule from './zlib.js';
import * as stringDecoderModule from './string_decoder.js';
import * as ttyModule from './tty.js';
import * as dnsModule from './dns.js';
import { createModuleShim } from './module.js';
import * as readlineModule from './readline.js';
import * as diagnosticsChannelModule from './diagnostics_channel.js';
import * as asyncHooksModule from './async_hooks.js';
import { createRimraf } from './rimraf.js';
import { createEsbuild } from './esbuild.js';

// Fake ephemeral port source for net/tls Server stubs (no real TCP in the VM).
let __fakeEphemeralPort = 49152;

/**
 * Wire up a fake net.Server EventEmitter. Node's `listen` has many overloads
 * (`listen(port, cb)`, `listen(port, host, cb)`, `listen(options, cb)`,
 * `listen(cb)`) and callers may await the `'listening'` event instead of a
 * callback — the previous stub only handled the 3-arg form, so port probes
 * (e.g. Expo's `freeport-async` calling `listen(0, cb)`) hung forever.
 */
function applyFakeServer(s: EventEmitter): void {
  let boundPort = 0;
  const rec = s as unknown as Record<string, unknown>;
  rec.listen = (...args: unknown[]) => {
    const cb = args.find((a) => typeof a === 'function') as (() => void) | undefined;
    let port = args.find((a) => typeof a === 'number') as number | undefined;
    if (port === undefined) {
      const opts = args.find((a) => a && typeof a === 'object') as { port?: number } | undefined;
      port = opts?.port;
    }
    boundPort = port && port > 0 ? port : __fakeEphemeralPort++;
    queueMicrotask(() => { s.emit('listening'); cb?.(); });
    return s;
  };
  rec.close = (cb?: () => void) => { queueMicrotask(() => { s.emit('close'); cb?.(); }); return s; };
  rec.address = () => ({ port: boundPort, family: 'IPv4', address: '127.0.0.1' });
  rec.getConnections = (cb?: (err: Error | null, count: number) => void) => { cb?.(null, 0); return s; };
  rec.unref = () => s;
  rec.ref = () => s;
}

export interface NodeContext {
  vfs: VFS;
  cwd: string;
  env: Record<string, string>;
  stdout: CommandOutputStream;
  stderr: CommandOutputStream;
  argv: string[];
  filename: string;
  dirname: string;
  signal: AbortSignal;
  executeCapture?: (input: string, opts?: { cwd?: string }) => Promise<string>;
  executeCaptureResult?: (input: string, opts?: { cwd?: string }) => Promise<{ stdout: string; code: number }>;
  portRegistry?: Map<number, VirtualRequestHandler>;
  /**
   * Execute CJS source in the VM's module system and return its module.exports.
   * Set by the node command; backs `require('module')`'s Module#_compile (used
   * by require-from-string, e.g. @expo/config evaluating app.config.js).
   */
  executeCjs?: (code: string, filename: string) => unknown;
}

export function createModuleMap(ctx: NodeContext): Record<string, () => unknown> {
  const map: Record<string, () => unknown> = {
    fs: () => createFs(ctx.vfs, ctx.cwd),
    'fs/promises': () => createFs(ctx.vfs, ctx.cwd).promises,
    path: () => pathModule,
    os: () => createOs(ctx.env),
    process: () => createProcess({
      argv: ctx.argv,
      env: ctx.env,
      cwd: ctx.cwd,
      stdout: ctx.stdout,
      stderr: ctx.stderr,
    }),
    events: () => {
      // Node.js CJS: require('events') returns the EventEmitter constructor itself
      const mod = EventEmitter as typeof EventEmitter & { EventEmitter: typeof EventEmitter; default: typeof EventEmitter };
      mod.EventEmitter = EventEmitter;
      mod.default = EventEmitter;
      return mod;
    },
    buffer: () => {
      const g = globalThis as {
        Blob?: unknown; File?: unknown; atob?: unknown; btoa?: unknown;
      };
      return {
        Buffer,
        SlowBuffer: Buffer,
        Blob: g.Blob,
        File: g.File,
        atob: g.atob,
        btoa: g.btoa,
        kMaxLength: 0x7fffffff,
        kStringMaxLength: 0x1fffffe8,
        constants: { MAX_LENGTH: 0x7fffffff, MAX_STRING_LENGTH: 0x1fffffe8 },
      };
    },
    util: () => utilModule,
    http: () => createHttp(ctx.portRegistry, 'http:'),
    https: () => createHttp(ctx.portRegistry, 'https:'),
    child_process: () => createChildProcess(ctx.executeCapture, ctx.executeCaptureResult),
    stream: () => {
      // Node.js CJS: require('stream') returns the Stream base class with
      // .Readable, .Writable, .Duplex, .PassThrough, .Stream attached
      const Stream = EventEmitter as unknown as (typeof EventEmitter & {
        Stream: typeof EventEmitter;
        Readable: typeof streamModule.Readable;
        Writable: typeof streamModule.Writable;
        Duplex: typeof streamModule.Duplex;
        Transform: typeof streamModule.Transform;
        PassThrough: typeof streamModule.PassThrough;
        default: typeof EventEmitter;
      });
      Stream.Stream = Stream;
      Stream.Readable = streamModule.Readable;
      Stream.Writable = streamModule.Writable;
      Stream.Duplex = streamModule.Duplex;
      Stream.Transform = streamModule.Transform;
      Stream.PassThrough = streamModule.PassThrough;
      Stream.default = Stream;

      // Stream state predicates + helpers (undici and others call these).
      type AnyStream = { destroyed?: boolean; readable?: boolean; writable?: boolean; on(ev: string, fn: (...a: unknown[]) => void): unknown; pipe?: (dest: unknown) => unknown };
      const S = Stream as unknown as Record<string, unknown>;
      S.isDisturbed = (s: AnyStream) => !!(s && s.destroyed);
      S.isErrored = (_s: AnyStream) => false;
      S.isReadable = (s: AnyStream) => !!(s && s.readable);
      S.isWritable = (s: AnyStream) => !!(s && s.writable);
      S.finished = (stream: AnyStream, optsOrCb: unknown, cb?: (err?: Error | null) => void) => {
        const callback = (typeof optsOrCb === 'function' ? optsOrCb : cb) as ((err?: Error | null) => void) | undefined;
        let done = false;
        const finish = (err?: Error | null) => { if (done) return; done = true; callback?.(err ?? null); };
        stream.on('end', () => finish());
        stream.on('finish', () => finish());
        stream.on('close', () => finish());
        stream.on('error', (e) => finish(e as Error));
        return () => { done = true; };
      };
      S.pipeline = (...args: unknown[]) => {
        const last = args[args.length - 1];
        const callback = typeof last === 'function' ? (args.pop() as (err?: Error | null) => void) : undefined;
        const streams = (args as AnyStream[]).flat() as AnyStream[];
        let src = streams[0];
        for (let i = 1; i < streams.length; i++) {
          src = src.pipe!(streams[i]) as AnyStream;
        }
        const tail = streams[streams.length - 1];
        if (callback) (S.finished as (s: AnyStream, cb: (e?: Error | null) => void) => void)(tail, callback);
        return tail;
      };
      S.addAbortSignal = (_signal: unknown, stream: AnyStream) => stream;
      // Promise-based API (require('stream').promises / 'stream/promises').
      // @expo/cli's FileSystemResponseCache does `stream.promises.finished(ws)`;
      // a missing .promises threw "reading 'finished' of undefined".
      const finishedP = (s: AnyStream): Promise<void> => new Promise((resolve, reject) => {
        const st = s as AnyStream & { destroyed?: boolean; _ended?: boolean; _writableState?: { finished?: boolean } };
        if (st.destroyed || st._ended || st._writableState?.finished) { resolve(); return; }
        let done = false;
        const ok = () => { if (!done) { done = true; resolve(); } };
        const bad = (e: unknown) => { if (!done) { done = true; reject(e as Error); } };
        s.on('finish', ok); s.on('end', ok); s.on('close', ok); s.on('error', bad);
      });
      S.promises = {
        finished: finishedP,
        pipeline: (...args: unknown[]) => {
          const streams = (args as AnyStream[]).flat().filter((a) => typeof a !== 'function') as AnyStream[];
          for (let i = 0; i < streams.length - 1; i++) streams[i].pipe!(streams[i + 1]);
          return finishedP(streams[streams.length - 1]);
        },
      };
      return Stream;
    },
    'stream/promises': () => (map.stream() as unknown as { promises: unknown }).promises,
    // require('stream/consumers') — buffer/text/json/arrayBuffer/blob of a
    // stream. fetch-nodeshim (pulled in by @expo/cli's fetch wrapper) needs it.
    // Accepts a Node Readable ('data'/'end'), a WHATWG ReadableStream
    // (getReader), or any async-iterable.
    'stream/consumers': () => {
      const collect = (stream: unknown): Promise<Buffer> => {
        const s = stream as {
          getReader?: () => { read(): Promise<{ done: boolean; value?: unknown }> };
          [Symbol.asyncIterator]?: () => AsyncIterator<unknown>;
          on?: (ev: string, fn: (...a: unknown[]) => void) => void;
          destroyed?: boolean; _ended?: boolean;
        };
        const toBuf = (c: unknown) => (Buffer.isBuffer(c) ? c : Buffer.from(c as ArrayBuffer | string));
        if (typeof s.getReader === 'function') {
          return (async () => {
            const reader = s.getReader!();
            const chunks: Buffer[] = [];
            for (;;) {
              const { done, value } = await reader.read();
              if (done) break;
              if (value !== undefined) chunks.push(toBuf(value));
            }
            return Buffer.concat(chunks);
          })();
        }
        if (typeof s[Symbol.asyncIterator] === 'function') {
          return (async () => {
            const chunks: Buffer[] = [];
            for await (const c of s as AsyncIterable<unknown>) chunks.push(toBuf(c));
            return Buffer.concat(chunks);
          })();
        }
        return new Promise<Buffer>((resolve, reject) => {
          const chunks: Buffer[] = [];
          if (!s.on) { resolve(Buffer.alloc(0)); return; }
          s.on('data', (c: unknown) => chunks.push(toBuf(c)));
          s.on('end', () => resolve(Buffer.concat(chunks)));
          s.on('error', (e: unknown) => reject(e as Error));
        });
      };
      return {
        buffer: collect,
        arrayBuffer: (s: unknown) => collect(s).then((b) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)),
        text: (s: unknown) => collect(s).then((b) => b.toString('utf8')),
        json: (s: unknown) => collect(s).then((b) => JSON.parse(b.toString('utf8'))),
        blob: (s: unknown) => collect(s).then((b) => new Blob([b])),
      };
    },
    url: () => urlModule,
    timers: () => timersModule,
    crypto: () => cryptoModule,
    zlib: () => zlibModule,
    string_decoder: () => stringDecoderModule,
    tty: () => ttyModule,
    dns: () => dnsModule,
    'dns/promises': () => dnsModule.promises,
    readline: () => readlineModule,
    'readline/promises': () => readlineModule.promises,
    diagnostics_channel: () => diagnosticsChannelModule,
    async_hooks: () => asyncHooksModule,
    'util/types': () => (utilModule as { typesImpl: unknown }).typesImpl,
    console: () => {
      const fmt = (utilModule as { format: (...a: unknown[]) => string }).format;
      const inspect = (utilModule as { inspect: (o: unknown) => string }).inspect;
      type Wr = { write(s: string): void };
      class Console {
        _stdout: Wr;
        _stderr: Wr;
        constructor(opts?: { stdout?: Wr; stderr?: Wr } | Wr) {
          const o = (opts && 'stdout' in opts ? opts.stdout : (opts as Wr)) as Wr | undefined;
          const e = (opts && 'stderr' in opts ? opts.stderr : undefined) as Wr | undefined;
          this._stdout = o || (ctx.stdout as unknown as Wr);
          this._stderr = e || o || (ctx.stderr as unknown as Wr);
        }
        log(...a: unknown[]): void { this._stdout.write(fmt(...a) + '\n'); }
        info(...a: unknown[]): void { this._stdout.write(fmt(...a) + '\n'); }
        debug(...a: unknown[]): void { this._stdout.write(fmt(...a) + '\n'); }
        error(...a: unknown[]): void { this._stderr.write(fmt(...a) + '\n'); }
        warn(...a: unknown[]): void { this._stderr.write(fmt(...a) + '\n'); }
        dir(o: unknown): void { this._stdout.write(inspect(o) + '\n'); }
        trace(...a: unknown[]): void { this._stderr.write('Trace: ' + fmt(...a) + '\n'); }
        assert(cond: unknown, ...a: unknown[]): void { if (!cond) this._stderr.write('Assertion failed' + (a.length ? ': ' + fmt(...a) : '') + '\n'); }
        table(data: unknown): void { this._stdout.write(inspect(data) + '\n'); }
        group(...a: unknown[]): void { if (a.length) this.log(...a); }
        groupEnd(): void { /* no-op */ }
        time(): void { /* no-op */ }
        timeEnd(): void { /* no-op */ }
        count(): void { /* no-op */ }
        clear(): void { /* no-op */ }
      }
      const instance = new Console({ stdout: ctx.stdout as unknown as Wr, stderr: ctx.stderr as unknown as Wr });
      return Object.assign(instance, { Console });
    },
    constants: () => {
      const fs = createFs(ctx.vfs, ctx.cwd);
      const os = createOs(ctx.env);
      return { ...os.constants, ...fs.constants };
    },
    querystring: () => ({
      parse: (str: string) => Object.fromEntries(new URLSearchParams(str)),
      stringify: (obj: Record<string, string>) => new URLSearchParams(obj).toString(),
      escape: encodeURIComponent,
      unescape: decodeURIComponent,
    }),
    assert: () => {
      // Real AssertionError class so `err instanceof assert.AssertionError`
      // checks (e.g. in @expo/cli's error handler) don't throw on undefined.
      class AssertionError extends Error {
        code = 'ERR_ASSERTION';
        constructor(opts?: { message?: string } | string) {
          super(typeof opts === 'string' ? opts : opts?.message || 'AssertionError');
          this.name = 'AssertionError';
        }
      }
      const fail = (message?: string): never => { throw new AssertionError(message || 'AssertionError'); };
      const assert = (value: unknown, message?: string) => {
        if (!value) fail(message);
      };
      assert.AssertionError = AssertionError;
      assert.fail = (message?: string) => fail(message);
      assert.ok = assert;
      assert.equal = (a: unknown, b: unknown, msg?: string) => { if (a != b) throw new Error(msg || `${a} != ${b}`); };
      assert.strictEqual = (a: unknown, b: unknown, msg?: string) => { if (a !== b) throw new Error(msg || `${a} !== ${b}`); };
      assert.notEqual = (a: unknown, b: unknown, msg?: string) => { if (a == b) throw new Error(msg || `${a} == ${b}`); };
      assert.notStrictEqual = (a: unknown, b: unknown, msg?: string) => { if (a === b) throw new Error(msg || `${a} === ${b}`); };

      // Structural deep-equality (Node semantics). recast's patcher calls
      // assert.deepEqual on AST fragments during native codegen; JSON.stringify
      // is not a valid substitute (key order, undefined, NaN, cycles), so walk
      // the values. `strict` toggles ===/SameValueZero vs == for primitives and
      // whether prototypes must match.
      const deepEq = (a: unknown, b: unknown, strict: boolean, seen: WeakMap<object, unknown>): boolean => {
        if (a === b) return true;
        // NaN
        if (typeof a === 'number' && typeof b === 'number' && Number.isNaN(a) && Number.isNaN(b)) return true;
        if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') {
          // primitives / mixed
          return strict ? a === b : a == b; // eslint-disable-line eqeqeq
        }
        const oa = a as Record<string, unknown> & object;
        const ob = b as Record<string, unknown> & object;
        if (strict && Object.getPrototypeOf(oa) !== Object.getPrototypeOf(ob)) return false;
        // cycle guard
        const prev = seen.get(oa);
        if (prev === ob) return true;
        seen.set(oa, ob);
        if (a instanceof Date || b instanceof Date) {
          return a instanceof Date && b instanceof Date && a.getTime() === b.getTime();
        }
        if (a instanceof RegExp || b instanceof RegExp) {
          return a instanceof RegExp && b instanceof RegExp && a.source === b.source && a.flags === b.flags;
        }
        const aArr = Array.isArray(a), bArr = Array.isArray(b);
        if (aArr !== bArr) return false;
        if (aArr && bArr) {
          if (a.length !== b.length) return false;
          for (let i = 0; i < a.length; i++) if (!deepEq(a[i], b[i], strict, seen)) return false;
          return true;
        }
        if (a instanceof Map || b instanceof Map) {
          if (!(a instanceof Map && b instanceof Map) || a.size !== b.size) return false;
          for (const [k, v] of a) { if (!b.has(k) || !deepEq(v, b.get(k), strict, seen)) return false; }
          return true;
        }
        if (a instanceof Set || b instanceof Set) {
          if (!(a instanceof Set && b instanceof Set) || a.size !== b.size) return false;
          for (const v of a) if (!b.has(v)) return false;
          return true;
        }
        const ka = Object.keys(oa), kb = Object.keys(ob);
        if (ka.length !== kb.length) return false;
        for (const k of ka) {
          if (!Object.prototype.hasOwnProperty.call(ob, k)) return false;
          if (!deepEq(oa[k], ob[k], strict, seen)) return false;
        }
        return true;
      };
      assert.deepEqual = (a: unknown, b: unknown, msg?: string) => { if (!deepEq(a, b, false, new WeakMap())) throw new AssertionError(msg || 'deepEqual failed'); };
      assert.deepStrictEqual = (a: unknown, b: unknown, msg?: string) => { if (!deepEq(a, b, true, new WeakMap())) throw new AssertionError(msg || 'deepStrictEqual failed'); };
      assert.notDeepEqual = (a: unknown, b: unknown, msg?: string) => { if (deepEq(a, b, false, new WeakMap())) throw new AssertionError(msg || 'notDeepEqual failed'); };
      assert.notDeepStrictEqual = (a: unknown, b: unknown, msg?: string) => { if (deepEq(a, b, true, new WeakMap())) throw new AssertionError(msg || 'notDeepStrictEqual failed'); };
      assert.throws = (fn: () => void, msg?: string) => {
        try { fn(); throw new Error(msg || 'Expected function to throw'); } catch (e) { if (e instanceof Error && e.message === (msg || 'Expected function to throw')) throw e; }
      };
      assert.doesNotThrow = (fn: () => void, msg?: string) => { try { fn(); } catch (e) { throw new AssertionError(msg || `Got unwanted exception: ${(e as Error)?.message ?? e}`); } };
      assert.ifError = (value: unknown) => { if (value !== null && value !== undefined) throw new AssertionError(`ifError got unwanted exception: ${value}`); };
      // Node exposes the assert function as both the default and .strict, and
      // (for transpiled `import assert from 'assert'`) as .default.
      assert.strict = assert;
      (assert as unknown as { default: unknown }).default = assert;
      return assert;
    },
    // v8 — stub (vite side-effect imports it)
    v8: () => ({
      getHeapStatistics: () => ({
        total_heap_size: 0, used_heap_size: 0, heap_size_limit: 0,
        total_physical_size: 0, total_available_size: 0,
        malloced_memory: 0, peak_malloced_memory: 0,
      }),
      serialize: (v: unknown) => new Uint8Array(0),
      deserialize: () => undefined,
    }),
    // perf_hooks — vite uses { performance } which is a browser global
    perf_hooks: () => ({
      performance: globalThis.performance,
      PerformanceObserver: globalThis.PerformanceObserver ?? class PerformanceObserver { observe() {} disconnect() {} },
    }),
    // net — stub (vite imports it but only uses it for actual TCP in server mode)
    net: () => ({
      createServer: (...cargs: unknown[]) => {
        const s = new EventEmitter() as unknown as Record<string, unknown>;
        const connCb = cargs.find((a) => typeof a === 'function') as (() => void) | undefined;
        if (connCb) (s as unknown as EventEmitter).on('connection', connCb);
        applyFakeServer(s as unknown as EventEmitter);
        return s;
      },
      createConnection: () => {
        const s = new EventEmitter() as unknown as Record<string, unknown>;
        s.write = () => true;
        s.end = () => s;
        s.destroy = () => s;
        s.connect = () => s;
        s.unref = () => s;
        s.ref = () => s;
        s.setTimeout = () => s;
        s.setNoDelay = () => s;
        s.setKeepAlive = () => s;
        return s;
      },
      connect: (...args: unknown[]) => {
        const s = new EventEmitter() as unknown as Record<string, unknown>;
        s.write = () => true;
        s.end = () => s;
        s.destroy = () => s;
        s.unref = () => s;
        s.ref = () => s;
        s.setTimeout = () => s;
        s.setNoDelay = () => s;
        s.setKeepAlive = () => s;
        // call connection callback if provided
        const cb = typeof args[args.length - 1] === 'function' ? args[args.length - 1] as () => void : null;
        if (cb) queueMicrotask(cb);
        return s;
      },
      Socket: class Socket extends EventEmitter {
        write() { return true; }
        end() { return this; }
        destroy() { return this; }
        connect() { return this; }
        unref() { return this; }
        ref() { return this; }
        setTimeout() { return this; }
        setNoDelay() { return this; }
        setKeepAlive() { return this; }
      },
      Server: class Server extends EventEmitter {
        constructor() { super(); applyFakeServer(this); }
      },
      isIP: (s: string) => /^\d+\.\d+\.\d+\.\d+$/.test(s) ? 4 : /^[0-9a-f:]+$/i.test(s) ? 6 : 0,
      isIPv4: (s: string) => /^\d+\.\d+\.\d+\.\d+$/.test(s),
      isIPv6: (s: string) => /^[0-9a-f:]+$/i.test(s),
    }),
    // tls — stub
    tls: () => ({
      createServer: (...cargs: unknown[]) => {
        const s = new EventEmitter() as unknown as Record<string, unknown>;
        const connCb = cargs.find((a) => typeof a === 'function') as (() => void) | undefined;
        if (connCb) (s as unknown as EventEmitter).on('secureConnection', connCb);
        applyFakeServer(s as unknown as EventEmitter);
        return s;
      },
      connect: () => {
        const s = new EventEmitter() as unknown as Record<string, unknown>;
        s.write = () => true;
        s.end = () => s;
        s.destroy = () => s;
        s.encrypted = true;
        return s;
      },
      TLSSocket: class TLSSocket extends EventEmitter {},
      SERVER_METHODS: [],
    }),
    // worker_threads — stub (vite uses it for thread pool but can fall back)
    worker_threads: () => ({
      isMainThread: true,
      parentPort: null,
      workerData: null,
      Worker: class Worker extends EventEmitter {
        constructor() { super(); }
        postMessage() {}
        terminate() { return Promise.resolve(0); }
      },
      threadId: 0,
    }),
    // http2 — stub (vite imports it for HTTP/2 server but falls back to HTTP/1.1)
    http2: () => ({
      createServer: () => {
        const s = new EventEmitter() as unknown as Record<string, unknown>;
        s.listen = (_port: unknown, _host: unknown, cb?: () => void) => { cb?.(); return s; };
        s.close = (cb?: () => void) => { cb?.(); return s; };
        s.setTimeout = () => s;
        return s;
      },
      createSecureServer: () => {
        const s = new EventEmitter() as unknown as Record<string, unknown>;
        s.listen = (_port: unknown, _host: unknown, cb?: () => void) => { cb?.(); return s; };
        s.close = (cb?: () => void) => { cb?.(); return s; };
        s.setTimeout = () => s;
        return s;
      },
      connect: () => {
        const s = new EventEmitter() as unknown as Record<string, unknown>;
        s.close = () => {};
        s.destroy = () => {};
        return s;
      },
      constants: {
        HTTP2_HEADER_PATH: ':path',
        HTTP2_HEADER_METHOD: ':method',
        HTTP2_HEADER_STATUS: ':status',
        HTTP2_HEADER_CONTENT_TYPE: 'content-type',
        HTTP_STATUS_OK: 200,
        HTTP_STATUS_INTERNAL_SERVER_ERROR: 500,
      },
      sensitiveHeaders: Symbol('nodejs.http2.sensitiveHeaders'),
      getDefaultSettings: () => ({}),
      getPackedSettings: () => Buffer.alloc(0),
      getUnpackedSettings: () => ({}),
    }),
    // inspector — stub (vite only uses it in --profile mode)
    inspector: () => ({
      Session: class Session extends EventEmitter {
        connect() {}
        disconnect() {}
        post(_method: string, _params?: unknown, cb?: () => void) {
          if (typeof _params === 'function') { _params(); return; }
          cb?.();
        }
      },
      open: () => {},
      close: () => {},
      url: () => undefined,
    }),
  };

  // module shim needs access to the map itself for createRequire, and to the
  // context for Module#_compile (CJS execution via the node command).
  map.module = () => createModuleShim(map, ctx);

  // npm package shims
  map.rimraf = () => createRimraf(ctx.vfs, ctx.cwd);
  map.esbuild = () => createEsbuild({ vfs: ctx.vfs, cwd: ctx.cwd });

  return map;
}

export { ProcessExitError } from './process.js';
