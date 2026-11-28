import { Buffer } from './buffer.js';
import { EventEmitter } from './events.js';
import { StringDecoder } from './string_decoder.js';

export interface ReadableOptions {
  objectMode?: boolean;
  highWaterMark?: number;
  autoDestroy?: boolean;
  encoding?: string;
  /** Node's simplified construction: `new Readable({ read() { this.push(...) } })`. */
  read?: (this: Readable, size: number) => void | Promise<void>;
  destroy?: (this: Readable, err: Error | null, callback: (err?: Error | null) => void) => void;
}

/**
 * Readable with a working pull protocol: subclasses may implement `_read(size)`
 * (sync or async) and produce data via `push()`, ending with `push(null)`.
 * Flow starts when a 'data' listener attaches or `resume()` is called —
 * matching Node semantics closely enough for readdirp/chokidar-style streams.
 */
export class Readable extends EventEmitter {
  private _buffer: unknown[] = [];
  protected _ended = false;
  private _endEmitted = false;
  private _flowing = false;
  private _reading = false;
  private _pushCount = 0;
  destroyed = false;
  readable = true;
  readonly _objectMode: boolean;
  readonly _highWaterMark: number;

  constructor(opts?: ReadableOptions) {
    super();
    this._objectMode = !!opts?.objectMode;
    this._highWaterMark = opts?.highWaterMark ?? (this._objectMode ? 16 : 65536);
    // Next.js replays React's flight data through `new Readable({ read() { this.push(...) } })`.
    if (opts?.read) this._read = opts.read;
    if (opts?.destroy) this._destroy = opts.destroy;
  }

  /** Subclass/option hook run by destroy(): release resources, then call back. */
  _destroy(err: Error | null, callback: (err?: Error | null) => void): void {
    callback(err);
  }

  /** Subclasses override to produce data on demand. May be async. */
  _read(_size: number): void | Promise<void> {
    // Default: passive stream fed externally via push().
  }

  push(chunk: unknown): boolean {
    if (this.destroyed) return false;
    if (chunk === null) {
      this._ended = true;
      if (!this._flowing) this._scheduleReadable(); // paused readers learn of the end too
      this._maybeEmitEnd();
      return false;
    }
    this._pushCount++;
    // A byte stream hands out Buffers, as Node's does: a plain Uint8Array pushed in comes out as
    // a Buffer view of it (Next.js inlines React's flight data with chunk.toString('utf-8'),
    // which on a Uint8Array lists the byte values instead).
    if (!this._objectMode && chunk instanceof Uint8Array && !Buffer.isBuffer(chunk)) {
      chunk = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    }
    if (this._flowing && this._buffer.length === 0) {
      this.emit('data', this._decode(chunk));
    } else {
      this._buffer.push(chunk);
      if (!this._flowing) this._scheduleReadable();
    }
    return this._buffer.length < this._highWaterMark;
  }

  /**
   * Paused mode (Node's read()): the next buffered chunk, or null. An empty buffer asks the
   * stream for more (`_read`), and 'readable' fires when it arrives; once the stream has ended
   * and the last chunk is read, 'end' follows. (Next.js pulls React's flight data this way.)
   */
  read(_size?: number): unknown {
    if (this._buffer.length > 0) {
      const chunk = this._decode(this._buffer.shift());
      if (this._buffer.length === 0) {
        if (this._ended) queueMicrotask(() => this._maybeEmitEnd());
        else this._pull();
      }
      return chunk;
    }
    if (this._ended) this._maybeEmitEnd();
    else this._pull();
    return null;
  }

  /** Bytes (or objects, in object mode) waiting to be read. */
  get readableLength(): number {
    if (this._objectMode) return this._buffer.length;
    let n = 0;
    for (const c of this._buffer) n += (c as { length?: number })?.length ?? 1;
    return n;
  }

  /** 'end' has been emitted. */
  get readableEnded(): boolean {
    return this._endEmitted;
  }

  get readableFlowing(): boolean | null {
    return this._flowing ? true : this._paused ? false : null;
  }

  override on(event: string, listener: (...args: unknown[]) => void): this {
    super.on(event, listener);
    if (event === 'data' && !this._paused) this.resume();
    if (event === 'readable') {
      // A 'readable' listener switches to paused mode, as in Node.
      this._flowing = false;
      this._paused = true;
      if (this._buffer.length > 0 || this._ended) this._scheduleReadable();
      else this._pull();
    }
    return this;
  }

  private _readableScheduled = false;
  /** Set once the stream is paused (pause() or a 'readable' listener): 'data' won't resume it. */
  private _paused = false;

  private _scheduleReadable(): void {
    if (this._readableScheduled) return;
    this._readableScheduled = true;
    queueMicrotask(() => {
      this._readableScheduled = false;
      if (!this._flowing && !this.destroyed) this.emit('readable');
    });
  }

  /** Ask the stream for data (paused mode): one `_read` at a time. */
  private _pull(): void {
    if (this._reading || this._ended || this.destroyed) return;
    this._reading = true;
    queueMicrotask(async () => {
      try {
        await this._read(this._highWaterMark);
      } catch (err) {
        this._reading = false;
        this.destroy(err);
        return;
      }
      this._reading = false;
    });
  }

  pipe<T extends Writable>(dest: T): T {
    this.on('data', (chunk) => dest.write(chunk as string));
    this.on('end', () => dest.end());
    this.resume(); // as in Node, piping starts the flow even from a paused stream
    return dest;
  }

  destroy(err?: unknown): this {
    if (this.destroyed) return this;
    this.destroyed = true;
    this._ended = true;
    this.readable = false;
    this._destroy((err as Error | undefined) ?? null, (e) => {
      if (e) this.emit('error', e);
      this.emit('close');
    });
    return this;
  }

  /** After setEncoding(), chunks come out as strings, decoded across chunk boundaries. */
  private _decoder: { write(bytes: Uint8Array): string } | null = null;
  private _encoding: string | null = null;

  setEncoding(encoding: string): this {
    const norm = String(encoding || 'utf8').toLowerCase().replace(/[-_]/g, '');
    this._encoding = encoding || 'utf8';
    this._decoder = ['utf8', 'utf16le', 'ucs2', 'latin1', 'binary', 'ascii'].includes(norm)
      ? new (StringDecoder as unknown as new (enc: string) => { write(b: Uint8Array): string })(this._encoding)
      : { write: (bytes) => Buffer.from(bytes).toString(this._encoding as BufferEncoding) };
    return this;
  }

  get readableEncoding(): string | null {
    return this._encoding;
  }

  get readableObjectMode(): boolean {
    return this._objectMode;
  }

  get readableHighWaterMark(): number {
    return this._highWaterMark;
  }

  private _decode(chunk: unknown): unknown {
    return this._decoder && !this._objectMode && chunk instanceof Uint8Array ? this._decoder.write(chunk) : chunk;
  }

  resume(): this {
    if (this.destroyed || this._flowing) return this;
    this._flowing = true;
    this._paused = false;
    queueMicrotask(() => void this._flow());
    return this;
  }

  pause(): this {
    this._flowing = false;
    this._paused = true;
    return this;
  }

  private async _flow(): Promise<void> {
    if (!this._flowing || this.destroyed) return;
    while (this._flowing && this._buffer.length > 0) {
      this.emit('data', this._decode(this._buffer.shift()));
    }
    if (this._ended) {
      this._maybeEmitEnd();
      return;
    }
    if (this._reading) return;
    this._reading = true;
    const before = this._pushCount;
    try {
      await this._read(this._highWaterMark);
    } catch (err) {
      this._reading = false;
      this.destroy(err);
      return;
    }
    this._reading = false;
    // Only keep pulling if _read produced something (or ended) — a passive
    // stream's no-op _read must not spin the microtask queue forever.
    if (this._ended || this._buffer.length > 0 || this._pushCount > before) {
      queueMicrotask(() => void this._flow());
    }
  }

  private _maybeEmitEnd(): void {
    if (this._endEmitted || !this._ended || this._buffer.length > 0) return;
    this._endEmitted = true;
    this.readable = false;
    this.emit('end');
    this.emit('close');
  }

  /**
   * `for await (const chunk of readable)`: the chunks in order until 'end'; an 'error' rejects,
   * and a close before 'end' is ERR_STREAM_PREMATURE_CLOSE. Leaving the loop early destroys the
   * stream, as in Node. (Next.js reads React's flight data into the page this way.)
   */
  [Symbol.asyncIterator](): AsyncIterableIterator<unknown> {
    const queue: unknown[] = [];
    let ended = false;
    let failure: unknown = null;
    let wake: (() => void) | null = null;
    const notify = () => { const w = wake; wake = null; w?.(); };
    const onData = (chunk: unknown) => { queue.push(chunk); notify(); };
    const onEnd = () => { ended = true; notify(); };
    const onError = (err: unknown) => { failure ??= err; notify(); };
    const onClose = () => {
      if (!ended) failure ??= Object.assign(new Error('Premature close'), { code: 'ERR_STREAM_PREMATURE_CLOSE' });
      notify();
    };
    const cleanup = () => {
      this.off('data', onData);
      this.off('end', onEnd);
      this.off('error', onError);
      this.off('close', onClose);
    };
    this.on('end', onEnd);
    this.on('error', onError);
    this.on('close', onClose);
    this.on('data', onData);
    const iterator: AsyncIterableIterator<unknown> = {
      next: async () => {
        for (;;) {
          if (queue.length > 0) return { value: queue.shift(), done: false };
          if (ended) { cleanup(); return { value: undefined, done: true }; }
          if (failure) { cleanup(); throw failure; }
          await new Promise<void>((resolve) => { wake = resolve; });
        }
      },
      return: async () => {
        cleanup();
        if (!ended) this.destroy();
        return { value: undefined, done: true };
      },
      [Symbol.asyncIterator]() { return iterator; },
    };
    return iterator;
  }

  /** Create a Readable from an iterable / async iterable (Node's Readable.from). */
  static from(iterable: Iterable<unknown> | AsyncIterable<unknown>, opts?: ReadableOptions): Readable {
    // Node treats a string or Buffer/TypedArray as a SINGLE chunk, not an
    // iterable of chars/bytes. Iterating a Buffer yields numbers, which then
    // surface downstream as non-Uint8Array chunks (undici's readAllBytes throws
    // "Received non-Uint8Array chunk" — hit by @expo/cli's response cache).
    if (typeof iterable === 'string' || iterable instanceof Uint8Array) {
      const r = new Readable(opts);
      r.push(iterable);
      r.push(null);
      return r;
    }
    const r = new Readable({ objectMode: true, ...opts });
    (async () => {
      try {
        for await (const chunk of iterable as AsyncIterable<unknown>) {
          if (r.destroyed) return;
          r.push(chunk);
        }
        r.push(null);
      } catch (err) {
        r.destroy(err);
      }
    })();
    return r;
  }

  /** Convert a Node Readable into a WHATWG ReadableStream (Node's Readable.toWeb). */
  static toWeb(streamReadable: Readable): ReadableStream {
    return new ReadableStream({
      start(controller) {
        streamReadable.on('data', (chunk) => {
          try { controller.enqueue(chunk as Uint8Array); } catch { /* closed */ }
        });
        streamReadable.on('end', () => {
          try { controller.close(); } catch { /* already closed */ }
        });
        streamReadable.on('error', (err) => {
          try { controller.error(err); } catch { /* already errored */ }
        });
      },
      cancel() {
        streamReadable.destroy();
      },
    });
  }

  /** Convert a WHATWG ReadableStream into a Node Readable (Node's Readable.fromWeb). */
  static fromWeb(webStream: ReadableStream, opts?: ReadableOptions): Readable {
    const r = new Readable(opts);
    const reader = webStream.getReader();
    (async () => {
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (r.destroyed) { try { await reader.cancel(); } catch { /* ignore */ } return; }
          r.push(value);
        }
        r.push(null);
      } catch (err) {
        r.destroy(err);
      }
    })();
    return r;
  }
}

export class Writable extends EventEmitter {
  private _ended = false;
  destroyed = false;
  writable = true;
  /** Node-internal-shaped state some libraries poke directly (e.g. ws). */
  _writableState = { finished: false, errorEmitted: false, ended: false };

  declare _final?: (callback: (err?: Error | null) => void) => void;
  readonly _writableObjectMode: boolean;
  readonly _writableHighWaterMark: number;

  /** Node's: end() was called / every write is done and 'finish' was emitted. */
  get writableEnded(): boolean { return this._ended; }
  get writableFinished(): boolean { return this._writableState.finished; }
  get writableObjectMode(): boolean { return this._writableObjectMode; }
  get writableHighWaterMark(): number { return this._writableHighWaterMark; }
  /** Writes go through at once here, so nothing waits in a buffer. */
  get writableLength(): number { return 0; }
  get writableNeedDrain(): boolean { return false; }
  get writableCorked(): number { return 0; }

  constructor(opts?: {
    objectMode?: boolean;
    highWaterMark?: number;
    autoDestroy?: boolean;
    /** Node's simplified construction: `new Writable({ write(chunk, enc, cb) {...} })`. */
    write?: (chunk: unknown, encoding: string, callback: (err?: Error | null) => void) => void;
    final?: (callback: (err?: Error | null) => void) => void;
  }) {
    super();
    this._writableObjectMode = !!opts?.objectMode;
    this._writableHighWaterMark = opts?.highWaterMark ?? (this._writableObjectMode ? 16 : 65536);
    if (opts?.write) this._write = opts.write;
    if (opts?.final) this._final = opts.final;
  }

  /**
   * Subclass hook (Node Writable protocol). When a subclass overrides _write
   * (e.g. ws's frame Receiver), write() routes chunks through it; the base
   * implementation preserves the legacy behavior of emitting 'data'.
   */
  _write(chunk: unknown, _encoding: string, callback: (err?: Error | null) => void): void {
    this.emit('data', chunk);
    callback();
  }

  write(chunk: unknown, encodingOrCb?: string | ((err?: Error | null) => void), cb?: (err?: Error | null) => void): boolean {
    if (this._ended || this.destroyed) return false;
    const callback = typeof encodingOrCb === 'function' ? encodingOrCb : cb;
    const encoding = typeof encodingOrCb === 'string' ? encodingOrCb : 'buffer';
    this._write(chunk, encoding, (err) => {
      if (err) {
        if (callback) callback(err);
        this.emit('error', err);
        return;
      }
      if (callback) callback();
    });
    return true;
  }

  end(chunk?: unknown, encodingOrCb?: unknown, cb?: () => void): void {
    const done = typeof chunk === 'function' ? chunk : typeof encodingOrCb === 'function' ? encodingOrCb : cb;
    if (chunk !== undefined && chunk !== null && typeof chunk !== 'function') this.write(chunk);
    this._ended = true;
    this.writable = false;
    this._writableState.ended = true;
    const finish = () => {
      this._writableState.finished = true;
      this.emit('finish');
      this.emit('close');
      if (typeof done === 'function') (done as () => void)();
    };
    if (!this._final) return finish();
    this._final((err) => {
      if (err) { this._writableState.errorEmitted = true; this.emit('error', err); return; }
      finish();
    });
  }

  destroy(err?: unknown): this {
    if (this.destroyed) return this;
    this.destroyed = true;
    this._ended = true;
    this.writable = false;
    if (err) {
      this._writableState.errorEmitted = true;
      this.emit('error', err);
    }
    this.emit('close');
    return this;
  }
}

export class Duplex extends Readable {
  writable = true;
  protected _writableEnded = false;

  /** Node's: end() was called on the writable side (Next.js checks it when its stream closes). */
  get writableEnded(): boolean { return this._writableEnded; }

  write(chunk: string, _encoding?: string, cb?: () => void): boolean {
    if (this._writableEnded) return false;
    this.emit('data', chunk);
    if (cb) cb();
    return true;
  }

  end(chunk?: string): void {
    if (chunk) this.write(chunk);
    this._writableEnded = true;
    this.writable = false;
    this.emit('finish');
  }
}

type TransformCallback = (error?: Error | null, data?: unknown) => void;

/**
 * Transform stream: writes flow through `_transform` and pushed results become
 * readable output. Subclasses (e.g. undici's InflateStream, zlib streams)
 * override `_transform`/`_flush`.
 */
export class Transform extends Duplex {
  /** Node's decodeStrings: strings written to a byte stream reach _transform as Buffers. */
  private readonly _decodeStrings: boolean;

  constructor(opts?: ReadableOptions & { decodeStrings?: boolean; writableObjectMode?: boolean; transform?: (chunk: unknown, enc: string, cb: TransformCallback) => void; flush?: (cb: TransformCallback) => void }) {
    super(opts);
    this._decodeStrings = !opts?.objectMode && !opts?.writableObjectMode && opts?.decodeStrings !== false;
    if (opts?.transform) this._transform = opts.transform;
    if (opts?.flush) this._flush = opts.flush;
  }

  _transform(chunk: unknown, _encoding: string, callback: TransformCallback): void {
    callback(null, chunk);
  }

  _flush(callback: TransformCallback): void {
    callback();
  }

  override write(chunk: unknown, encoding?: string | (() => void), cb?: (err?: Error | null) => void): boolean {
    let enc = typeof encoding === 'string' ? encoding : 'buffer';
    const done = typeof encoding === 'function' ? encoding : cb;
    // React's Node renderer writes strings into the PassThrough Next.js gives it; Next copies
    // each chunk as bytes (`new Uint8Array(chunk)`), which is empty for a string.
    if (typeof chunk === 'string' && this._decodeStrings) {
      chunk = Buffer.from(chunk, (enc === 'buffer' ? 'utf8' : enc) as BufferEncoding);
      enc = 'buffer';
    }
    try {
      this._transform(chunk, enc, (err, data) => {
        if (err) { this.emit('error', err); if (done) done(err); return; }
        if (data !== null && data !== undefined) this.push(data);
        if (done) done();
      });
    } catch (err) {
      this.emit('error', err);
    }
    return true;
  }

  override end(chunk?: unknown, encoding?: string | (() => void), cb?: () => void): void {
    const done = typeof chunk === 'function' ? chunk
      : typeof encoding === 'function' ? encoding
      : cb;
    this.writable = false;
    const finish = () => {
      this._writableEnded = true;
      try {
        this._flush((err, data) => {
          if (err) { this.emit('error', err); return; }
          if (data !== null && data !== undefined) this.push(data);
          this.push(null); // close the readable side → 'end'
          this.emit('finish');
          if (done) done();
        });
      } catch (err) {
        this.emit('error', err);
      }
    };
    if (chunk !== undefined && typeof chunk !== 'function') {
      this.write(chunk, typeof encoding === 'string' ? encoding : undefined, finish);
    } else {
      finish();
    }
  }
}

export class PassThrough extends Transform {}

export default { Readable, Writable, Duplex, Transform, PassThrough };
