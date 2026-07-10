import { EventEmitter } from './events.js';

export interface ReadableOptions {
  objectMode?: boolean;
  highWaterMark?: number;
  autoDestroy?: boolean;
  encoding?: string;
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
  }

  /** Subclasses override to produce data on demand. May be async. */
  _read(_size: number): void | Promise<void> {
    // Default: passive stream fed externally via push().
  }

  push(chunk: unknown): boolean {
    if (this.destroyed) return false;
    if (chunk === null) {
      this._ended = true;
      this._maybeEmitEnd();
      return false;
    }
    this._pushCount++;
    if (this._flowing && this._buffer.length === 0) {
      this.emit('data', chunk);
    } else {
      this._buffer.push(chunk);
    }
    return this._buffer.length < this._highWaterMark;
  }

  read(): unknown {
    if (this._buffer.length > 0) {
      const chunk = this._buffer.shift();
      this._maybeEmitEnd();
      return chunk;
    }
    return null;
  }

  override on(event: string, listener: (...args: unknown[]) => void): this {
    super.on(event, listener);
    if (event === 'data') this.resume();
    return this;
  }

  pipe<T extends Writable>(dest: T): T {
    this.on('data', (chunk) => dest.write(chunk as string));
    this.on('end', () => dest.end());
    return dest;
  }

  destroy(err?: unknown): this {
    if (this.destroyed) return this;
    this.destroyed = true;
    this._ended = true;
    this.readable = false;
    if (err) this.emit('error', err);
    this.emit('close');
    return this;
  }

  setEncoding(_encoding: string): this {
    return this;
  }

  resume(): this {
    if (this.destroyed || this._flowing) return this;
    this._flowing = true;
    queueMicrotask(() => void this._flow());
    return this;
  }

  pause(): this {
    this._flowing = false;
    return this;
  }

  private async _flow(): Promise<void> {
    if (!this._flowing || this.destroyed) return;
    while (this._flowing && this._buffer.length > 0) {
      this.emit('data', this._buffer.shift());
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

  constructor(_opts?: { objectMode?: boolean; highWaterMark?: number; autoDestroy?: boolean }) {
    super();
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

  end(chunk?: unknown): void {
    if (chunk !== undefined && chunk !== null) this.write(chunk);
    this._ended = true;
    this.writable = false;
    this._writableState.ended = true;
    this._writableState.finished = true;
    this.emit('finish');
    this.emit('close');
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
  private _writableEnded = false;

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
  constructor(opts?: ReadableOptions & { transform?: (chunk: unknown, enc: string, cb: TransformCallback) => void; flush?: (cb: TransformCallback) => void }) {
    super(opts);
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
    const enc = typeof encoding === 'string' ? encoding : 'buffer';
    const done = typeof encoding === 'function' ? encoding : cb;
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
    const finish = () => {
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
