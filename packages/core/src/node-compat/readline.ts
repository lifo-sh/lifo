/**
 * Node.js `readline` module shim for Lifo.
 *
 * Provides Interface (createInterface), clearLine, clearScreenDown,
 * cursorTo, moveCursor, and the promises API.
 */

import { EventEmitter } from './events.js';

export interface InterfaceOptions {
  input?: { on?: (event: string, cb: (...args: unknown[]) => void) => void };
  output?: { write?: (data: string) => void };
  prompt?: string;
  terminal?: boolean;
  historySize?: number;
  completer?: (line: string) => [string[], string];
  crlfDelay?: number;
}

export class Interface extends EventEmitter {
  private _prompt: string;
  private _output: { write?: (data: string) => void } | undefined;
  private _closed = false;
  private _lines: string[] = [];
  terminal: boolean;

  constructor(opts: InterfaceOptions = {}) {
    super();
    this._prompt = opts.prompt ?? '> ';
    this._output = opts.output;
    this.terminal = opts.terminal ?? false;

    // Listen for data on input if provided
    if (opts.input?.on) {
      opts.input.on('data', (chunk) => {
        if (this._closed) return;
        const lines = String(chunk).split(/\r?\n/);
        for (const line of lines) {
          if (line !== '') {
            this._lines.push(line);
            this.emit('line', line);
          }
        }
      });

      opts.input.on('end', () => {
        if (!this._closed) this.close();
      });
    }
  }

  setPrompt(prompt: string): void {
    this._prompt = prompt;
  }

  getPrompt(): string {
    return this._prompt;
  }

  prompt(preserveCursor = false): void {
    if (this._closed) return;
    void preserveCursor;
    this._output?.write?.(this._prompt);
  }

  write(data: string): void {
    if (this._closed) return;
    const lines = data.split(/\r?\n/);
    for (const line of lines) {
      if (line !== '') {
        this._lines.push(line);
        this.emit('line', line);
      }
    }
  }

  question(query: string, cb: (answer: string) => void): void;
  question(query: string, options: { signal?: AbortSignal }, cb: (answer: string) => void): void;
  question(
    query: string,
    optionsOrCb: { signal?: AbortSignal } | ((answer: string) => void),
    cb?: (answer: string) => void,
  ): void {
    if (this._closed) return;
    const callback = typeof optionsOrCb === 'function' ? optionsOrCb : cb!;
    this._output?.write?.(query);
    // Answer comes from next line event
    this.once('line', (line) => callback(line as string));
  }

  close(): void {
    if (this._closed) return;
    this._closed = true;
    this.emit('close');
  }

  pause(): this {
    this.emit('pause');
    return this;
  }

  resume(): this {
    this.emit('resume');
    return this;
  }

  getCursorPos(): { rows: number; cols: number } {
    return { rows: 0, cols: 0 };
  }

  get closed(): boolean {
    return this._closed;
  }

  [Symbol.asyncIterator](): AsyncIterableIterator<string> {
    const iface = this;
    const queue: string[] = [];
    let resolveNext: ((value: IteratorResult<string>) => void) | null = null;

    iface.on('line', (line) => {
      if (resolveNext) {
        const r = resolveNext;
        resolveNext = null;
        r({ value: line as string, done: false });
      } else {
        queue.push(line as string);
      }
    });

    iface.on('close', () => {
      if (resolveNext) {
        const r = resolveNext;
        resolveNext = null;
        r({ value: undefined as unknown as string, done: true });
      }
    });

    return {
      next(): Promise<IteratorResult<string>> {
        if (queue.length > 0) {
          return Promise.resolve({ value: queue.shift()!, done: false });
        }
        if (iface._closed) {
          return Promise.resolve({ value: undefined as unknown as string, done: true });
        }
        return new Promise((resolve) => { resolveNext = resolve; });
      },
      return(): Promise<IteratorResult<string>> {
        iface.close();
        return Promise.resolve({ value: undefined as unknown as string, done: true });
      },
      throw(err: Error): Promise<IteratorResult<string>> {
        iface.close();
        return Promise.reject(err);
      },
      [Symbol.asyncIterator]() { return this; },
    };
  }
}

export function createInterface(opts: InterfaceOptions): Interface;
export function createInterface(
  input: InterfaceOptions['input'],
  output?: InterfaceOptions['output'],
): Interface;
export function createInterface(
  inputOrOpts: InterfaceOptions | InterfaceOptions['input'],
  output?: InterfaceOptions['output'],
): Interface {
  if (inputOrOpts && typeof inputOrOpts === 'object' && ('input' in inputOrOpts || 'output' in inputOrOpts || 'prompt' in inputOrOpts)) {
    return new Interface(inputOrOpts as InterfaceOptions);
  }
  return new Interface({ input: inputOrOpts as InterfaceOptions['input'], output });
}

export function clearLine(stream: { write?: (data: string) => void }, dir: number, cb?: () => void): boolean {
  void stream;
  void dir;
  cb?.();
  return true;
}

export function clearScreenDown(stream: { write?: (data: string) => void }, cb?: () => void): boolean {
  void stream;
  cb?.();
  return true;
}

export function cursorTo(stream: { write?: (data: string) => void }, x: number, y?: number | (() => void), cb?: () => void): boolean {
  void stream;
  void x;
  if (typeof y === 'function') { y(); return true; }
  cb?.();
  return true;
}

export function moveCursor(stream: { write?: (data: string) => void }, dx: number, dy: number, cb?: () => void): boolean {
  void stream;
  void dx;
  void dy;
  cb?.();
  return true;
}

export function emitKeypressEvents(_stream: unknown): void {
  // no-op
}

// readline/promises API
export const promises = {
  createInterface: (opts: InterfaceOptions): Interface & { question: (query: string, options?: { signal?: AbortSignal }) => Promise<string> } => {
    const iface = createInterface(opts);
    const promiseIface = iface as Interface & { question: (query: string, options?: { signal?: AbortSignal }) => Promise<string> };
    const originalQuestion = iface.question.bind(iface);
    promiseIface.question = (query: string, _options?: { signal?: AbortSignal }): Promise<string> => {
      return new Promise((resolve) => {
        originalQuestion(query, (answer: string) => resolve(answer));
      });
    };
    return promiseIface;
  },
};

export default {
  Interface,
  createInterface,
  clearLine,
  clearScreenDown,
  cursorTo,
  moveCursor,
  emitKeypressEvents,
  promises,
};
