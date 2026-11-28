/**
 * Node.js `readline` module shim for Lifo.
 *
 * Provides Interface (createInterface), clearLine, clearScreenDown,
 * cursorTo, moveCursor, and the promises API.
 */

import { EventEmitter } from './events.js';

export interface InterfaceOptions {
  input?: {
    on?: (event: string, cb: (...args: unknown[]) => void) => void;
    removeListener?: (event: string, cb: (...args: unknown[]) => void) => void;
    listenerCount?: (event: string) => number;
    listeners?: (event: string) => unknown[];
    pause?: () => unknown;
    resume?: () => unknown;
    isTTY?: boolean;
    setRawMode?: (enabled: boolean) => unknown;
  };
  output?: { write?: (data: string) => void };
  prompt?: string;
  terminal?: boolean;
  historySize?: number;
  completer?: (line: string) => [string[], string];
  crlfDelay?: number;
}

/**
 * How many readline interfaces are open on a stream, kept on the stream itself. An open one
 * on the terminal means a prompt is waiting for the user, so the node runner keeps the run
 * alive for it (process.ts `isPrompting`).
 */
export const OPEN_READLINE_INTERFACES = Symbol.for('lifo.readline.openInterfaces');

interface Key {
  name?: string;
  sequence?: string;
  ctrl?: boolean;
  meta?: boolean;
  shift?: boolean;
}

type Listener = (...args: unknown[]) => void;

export class Interface extends EventEmitter {
  /** The line being edited (terminal mode), as Node exposes it. Prompt libraries read it. */
  line = '';
  /** Cursor position within `line`. */
  cursor = 0;
  private _prompt: string;
  private _output: { write?: (data: string) => void } | undefined;
  private _input: InterfaceOptions['input'];
  private _onData?: Listener;
  private _onEnd?: Listener;
  private _onKeypress?: Listener;
  private _rawModeSet = false;
  private _sawReturnAt = 0;
  private _crlfDelay: number;
  private _closed = false;
  private _lines: string[] = [];
  terminal: boolean;

  constructor(opts: InterfaceOptions = {}) {
    super();
    this._prompt = opts.prompt ?? '> ';
    this._output = opts.output;
    this._input = opts.input;
    this.terminal = opts.terminal ?? false;
    this._crlfDelay = Math.max(opts.crlfDelay ?? 100, 100);

    const input = opts.input;
    if (input?.on) {
      if (this.terminal) {
        // Terminal mode, like Node: read keypresses and edit `line` in place. clack and
        // inquirer read `rl.line` / `rl.cursor` from their own keypress handlers, which run
        // after this one because it was attached first.
        emitKeypressEvents(input);
        this._onKeypress = (s, key) => {
          if (!this._closed) this._ttyWrite(typeof s === 'string' ? s : undefined, (key ?? {}) as Key);
        };
        input.on('keypress', this._onKeypress);
        if (input.isTTY && typeof input.setRawMode === 'function') {
          input.setRawMode(true);
          this._rawModeSet = true;
        }
        input.resume?.();
      } else {
        this._onData = (chunk) => {
          if (this._closed) return;
          const lines = String(chunk).split(/\r?\n/);
          for (const line of lines) {
            if (line !== '') {
              this._lines.push(line);
              this.emit('line', line);
            }
          }
        };
        input.on('data', this._onData);
      }

      this._onEnd = () => {
        if (!this._closed) this.close();
      };
      input.on('end', this._onEnd);

      const counted = input as unknown as Record<symbol, number | undefined>;
      counted[OPEN_READLINE_INTERFACES] = (counted[OPEN_READLINE_INTERFACES] ?? 0) + 1;
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

  /**
   * In terminal mode this is typed input: `write('abc')` inserts text and
   * `write(null, { ctrl: true, name: 'u' })` runs a key (clack clears and edits its field
   * this way). Otherwise each line becomes a 'line' event.
   */
  write(data: string | null | undefined, key?: Key): void {
    if (this._closed) return;
    if (this.terminal) {
      this._ttyWrite(data ?? undefined, key ?? {});
      return;
    }
    if (typeof data !== 'string') return;
    const lines = data.split(/\r?\n/);
    for (const line of lines) {
      if (line !== '') {
        this._lines.push(line);
        this.emit('line', line);
      }
    }
  }

  /** Node's terminal line editing, minus history and completion. */
  private _ttyWrite(s: string | undefined, key: Key): void {
    const name = key.name;
    if (key.ctrl) {
      switch (name) {
        case 'c':
          // Node: hand Ctrl+C to a SIGINT listener, or else this interface is done.
          if (this.listenerCount('SIGINT') > 0) this.emit('SIGINT');
          else this.close();
          return;
        case 'd':
          if (this.line.length === 0) this.close();
          else this._deleteRight();
          return;
        case 'h': this._deleteLeft(); return;
        case 'u': this._setLine(this.line.slice(this.cursor), 0); return;
        case 'k': this._setLine(this.line.slice(0, this.cursor), this.cursor); return;
        case 'a': this._moveTo(0); return;
        case 'e': this._moveTo(this.line.length); return;
        case 'b': this._moveTo(this.cursor - 1); return;
        case 'f': this._moveTo(this.cursor + 1); return;
        case 'w':
        case 'backspace': this._deleteWordLeft(); return;
        case 'left': this._moveTo(this._wordLeft()); return;
        case 'right': this._moveTo(this._wordRight()); return;
        default: return;
      }
    }
    switch (name) {
      case 'return':
      case 'enter': {
        // A CR LF pair is one Enter.
        const lf = key.sequence === '\n' || name === 'enter';
        if (lf && this._sawReturnAt && Date.now() - this._sawReturnAt <= this._crlfDelay) {
          this._sawReturnAt = 0;
          return;
        }
        this._sawReturnAt = lf ? 0 : Date.now();
        this._submitLine();
        return;
      }
      case 'backspace': this._deleteLeft(); return;
      case 'delete': this._deleteRight(); return;
      case 'left': this._moveTo(this.cursor - 1); return;
      case 'right': this._moveTo(this.cursor + 1); return;
      case 'home': this._moveTo(0); return;
      case 'end': this._moveTo(this.line.length); return;
      case 'up':
      case 'down':
      case 'pageup':
      case 'pagedown':
      case 'escape':
        return;
    }
    if (key.meta) {
      if (name === 'b') this._moveTo(this._wordLeft());
      else if (name === 'f') this._moveTo(this._wordRight());
      else if (name === 'backspace') this._deleteWordLeft();
      return;
    }
    if (typeof s === 'string' && s) {
      // Pasted text may hold line breaks: each one submits the line so far.
      const parts = s.split(/\r\n|\n|\r/);
      for (let i = 0; i < parts.length; i++) {
        if (i > 0) this._submitLine();
        this._insert(parts[i]);
      }
    }
  }

  private _insert(text: string): void {
    if (!text) return;
    const atEnd = this.cursor === this.line.length;
    this.line = this.line.slice(0, this.cursor) + text + this.line.slice(this.cursor);
    this.cursor += text.length;
    if (atEnd) this._output?.write?.(text);
    else this._refreshLine();
  }

  private _setLine(line: string, cursor: number): void {
    this.line = line;
    this.cursor = Math.max(0, Math.min(cursor, line.length));
    this._refreshLine();
  }

  private _moveTo(cursor: number): void {
    const next = Math.max(0, Math.min(cursor, this.line.length));
    if (next === this.cursor) return;
    this.cursor = next;
    this._refreshLine();
  }

  private _deleteLeft(): void {
    if (this.cursor === 0) return;
    this._setLine(this.line.slice(0, this.cursor - 1) + this.line.slice(this.cursor), this.cursor - 1);
  }

  private _deleteRight(): void {
    if (this.cursor >= this.line.length) return;
    this._setLine(this.line.slice(0, this.cursor) + this.line.slice(this.cursor + 1), this.cursor);
  }

  private _wordLeft(): number {
    const before = this.line.slice(0, this.cursor);
    const m = before.match(/\S+\s*$/);
    return m ? this.cursor - m[0].length : 0;
  }

  private _wordRight(): number {
    const m = this.line.slice(this.cursor).match(/^\s*\S+/);
    return m ? this.cursor + m[0].length : this.line.length;
  }

  private _deleteWordLeft(): void {
    const to = this._wordLeft();
    this._setLine(this.line.slice(0, to) + this.line.slice(this.cursor), to);
  }

  /** Echo the edited line (terminal mode, when there is an output to echo to). */
  private _refreshLine(): void {
    if (!this._output?.write) return;
    const prompt = this._prompt.slice(this._prompt.lastIndexOf('\n') + 1);
    const back = this.line.length - this.cursor;
    this._output.write(`\r\x1b[K${prompt}${this.line}${back > 0 ? `\x1b[${back}D` : ''}`);
  }

  private _submitLine(): void {
    const line = this.line;
    this.line = '';
    this.cursor = 0;
    this._output?.write?.('\r\n');
    this._lines.push(line);
    this.emit('line', line);
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
    const input = this._input;
    if (input) {
      if (this._onData) input.removeListener?.('data', this._onData);
      if (this._onEnd) input.removeListener?.('end', this._onEnd);
      if (this._onKeypress) input.removeListener?.('keypress', this._onKeypress);
      if (this._rawModeSet) input.setRawMode?.(false);
      const counted = input as unknown as Record<symbol, number | undefined>;
      if (counted[OPEN_READLINE_INTERFACES]) counted[OPEN_READLINE_INTERFACES]! -= 1;
      // Stop the input's flow, as Node's readline does, once nothing else reads it. The
      // keypress translator from emitKeypressEvents doesn't count: it outlives every prompt
      // and only feeds 'keypress' listeners. Leaving the stream flowing kept the
      // interactive stdin "active", so `npx <cli>` runs never went quiescent.
      if (!readersLeft(input)) input.pause?.();
    }
    this.emit('close');
  }

  pause(): this {
    this._input?.pause?.();
    this.emit('pause');
    return this;
  }

  resume(): this {
    this._input?.resume?.();
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

/** Whether anything besides the keypress translator still consumes this input. */
function readersLeft(input: NonNullable<InterfaceOptions['input']>): boolean {
  const keypress = typeof input.listenerCount === 'function' ? input.listenerCount('keypress') : 0;
  if (keypress > 0) return true;
  if (typeof input.listeners === 'function') {
    return input.listeners('data').some((fn) => !(fn as { __lifoKeypressSource?: boolean }).__lifoKeypressSource);
  }
  return typeof input.listenerCount === 'function' ? input.listenerCount('data') > 0 : false;
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

// These write real ANSI to the stream (they were no-op stubs). Metro's progress
// bar, ora spinners, and Expo's interface redraw in place via readline.cursorTo
// + readline.clearLine; without emitting the escapes nothing updated, so bars
// never filled and status lines never refreshed.
export function clearLine(stream: { write?: (data: string) => void }, dir: number, cb?: () => void): boolean {
  stream.write?.(dir < 0 ? '\x1b[1K' : dir > 0 ? '\x1b[0K' : '\x1b[2K');
  cb?.();
  return true;
}

export function clearScreenDown(stream: { write?: (data: string) => void }, cb?: () => void): boolean {
  stream.write?.('\x1b[0J');
  cb?.();
  return true;
}

export function cursorTo(stream: { write?: (data: string) => void }, x: number, y?: number | (() => void), cb?: () => void): boolean {
  if (typeof y === 'number') stream.write?.(`\x1b[${(y | 0) + 1};${(x | 0) + 1}H`);
  else { stream.write?.(`\x1b[${(x | 0) + 1}G`); cb = y as (() => void) | undefined; }
  cb?.();
  return true;
}

export function moveCursor(stream: { write?: (data: string) => void }, dx: number, dy: number, cb?: () => void): boolean {
  let s = '';
  if (dx > 0) s += `\x1b[${dx}C`; else if (dx < 0) s += `\x1b[${-dx}D`;
  if (dy > 0) s += `\x1b[${dy}B`; else if (dy < 0) s += `\x1b[${-dy}A`;
  if (s) stream.write?.(s);
  cb?.();
  return true;
}

/** Parse a raw input chunk into Node-style keypress events: [sequence, key]. */
function parseKeypress(chunk: string): Array<[string, Record<string, unknown>]> {
  const mk = (seq: string, extra: Record<string, unknown>): [string, Record<string, unknown>] =>
    [seq, { sequence: seq, name: undefined, ctrl: false, meta: false, shift: false, ...extra }];

  // Escape sequences (arrows, home/end, etc.) — xterm delivers these as one chunk.
  const ESC: Record<string, string> = {
    '\x1b[A': 'up', '\x1bOA': 'up', '\x1b[B': 'down', '\x1bOB': 'down',
    '\x1b[C': 'right', '\x1bOC': 'right', '\x1b[D': 'left', '\x1bOD': 'left',
    '\x1b[H': 'home', '\x1bOH': 'home', '\x1b[F': 'end', '\x1bOF': 'end',
    '\x1b[3~': 'delete', '\x1b[5~': 'pageup', '\x1b[6~': 'pagedown',
    '\x1b[Z': 'tab', // shift-tab
  };
  if (ESC[chunk]) {
    return [mk(chunk, { name: ESC[chunk], meta: chunk.startsWith('\x1bO'), shift: chunk === '\x1b[Z' })];
  }

  // Single control/printable characters.
  if (chunk.length === 1) {
    const c = chunk;
    const code = c.charCodeAt(0);
    if (c === '\r' || c === '\n') return [mk(c, { name: 'return' })];
    if (c === '\t') return [mk(c, { name: 'tab' })];
    if (c === '\x7f' || c === '\b') return [mk(c, { name: 'backspace' })];
    if (c === '\x1b') return [mk(c, { name: 'escape' })];
    if (c === ' ') return [mk(c, { name: 'space' })];
    // Ctrl+letter: 0x01–0x1a → a–z
    if (code >= 1 && code <= 26) {
      return [mk(c, { name: String.fromCharCode(code + 96), ctrl: true })];
    }
    // Printable
    const name = c.toLowerCase();
    return [mk(c, { name, shift: c !== name && c === c.toUpperCase() })];
  }

  // A multi-char paste / unknown sequence: emit per character so text input works.
  if (!chunk.startsWith('\x1b')) {
    return [...chunk].flatMap((c) => parseKeypress(c));
  }
  // Unknown escape sequence — surface it as a single opaque keypress.
  return [mk(chunk, { name: undefined })];
}

const KEYPRESS_ATTACHED = Symbol.for('lifo.readline.keypressAttached');

export function emitKeypressEvents(stream: unknown): void {
  const s = stream as {
    [KEYPRESS_ATTACHED]?: boolean;
    on?: (event: string, cb: (chunk: unknown) => void) => void;
    emit?: (event: string, ...args: unknown[]) => void;
  };
  if (!s || typeof s.on !== 'function' || typeof s.emit !== 'function') return;
  if (s[KEYPRESS_ATTACHED]) return;
  s[KEYPRESS_ATTACHED] = true;
  // Adding a 'data' listener puts our interactive stdin into flowing mode; each
  // keypress becomes 'keypress' events that prompt libraries (prompts/inquirer)
  // listen on. Arrow keys arrive as escape sequences and parse to up/down/etc.
  //
  // This listener is a translator, not a consumer: prompt libs listen on
  // 'keypress' and remove those listeners when they close, but nobody removes
  // THIS 'data' listener. Flag it so stdin.isActive() doesn't count it as an
  // active reader — otherwise the run never quiesces after an interactive
  // prompt (create-expo-app hung this way until Ctrl+C).
  const keypressSource = (chunk: unknown) => {
    const str = typeof chunk === 'string' ? chunk : String(chunk);
    for (const [seq, key] of parseKeypress(str)) {
      s.emit!('keypress', seq, key);
    }
  };
  (keypressSource as { __lifoKeypressSource?: boolean }).__lifoKeypressSource = true;
  s.on('data', keypressSource);
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
