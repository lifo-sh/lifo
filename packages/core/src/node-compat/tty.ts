import { Readable, Writable } from './stream.js';

/**
 * Node.js `tty` module shim for Lifo.
 *
 * In the browser there is no real TTY, so ReadStream/WriteStream behave like
 * plain streams with the TTY-specific properties stubbed to sensible defaults.
 */

export class ReadStream extends Readable {
  readonly isTTY = true;
  readonly isRaw = false;

  setRawMode(_mode: boolean): this {
    // no-op – raw mode is not applicable in the browser
    return this;
  }
}

export class WriteStream extends Writable {
  readonly isTTY = true;
  columns = 80;
  rows = 24;

  clearLine(_dir: number, _cb?: () => void): boolean {
    _cb?.();
    return true;
  }

  clearScreenDown(_cb?: () => void): boolean {
    _cb?.();
    return true;
  }

  cursorTo(_x: number, _y?: number | (() => void), _cb?: () => void): boolean {
    if (typeof _y === 'function') { _y(); return true; }
    _cb?.();
    return true;
  }

  moveCursor(_dx: number, _dy: number, _cb?: () => void): boolean {
    _cb?.();
    return true;
  }

  getColorDepth(): number {
    return 8; // 256 colours – reasonable default for a virtual terminal
  }

  hasColors(count?: number): boolean {
    if (count === undefined) return true;
    return count <= 256;
  }

  getWindowSize(): [number, number] {
    return [this.columns, this.rows];
  }
}

export function isatty(_fd: number): boolean {
  return false;
}

export default { ReadStream, WriteStream, isatty };
