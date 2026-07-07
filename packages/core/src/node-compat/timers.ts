// Node's `timers` module returns Timeout/Immediate objects with .ref()/.unref()/
// .refresh(), not the bare numeric id the browser's setTimeout returns. Code that
// does `require('timers').setTimeout(...).unref()` / `.refresh()` (e.g. Metro's
// metro-file-map DiskCacheManager) needs those methods, so wrap the global timers.
const g = globalThis;

export const _setTimeout = g.setTimeout;
export const _setInterval = g.setInterval;
export const _clearTimeout = g.clearTimeout;
export const _clearInterval = g.clearInterval;

class Timer {
  private _id: ReturnType<typeof g.setTimeout> | null;
  private readonly _fn: (...args: unknown[]) => void;
  private readonly _ms: number;
  private readonly _args: unknown[];
  private readonly _interval: boolean;

  constructor(fn: (...args: unknown[]) => void, ms: number, args: unknown[], interval: boolean) {
    this._fn = fn;
    this._ms = ms;
    this._args = args;
    this._interval = interval;
    this._id = interval ? g.setInterval(() => fn(...args), ms) : g.setTimeout(() => fn(...args), ms);
  }

  ref(): this { return this; }
  unref(): this { return this; }
  hasRef(): boolean { return true; }

  refresh(): this {
    this.close();
    this._id = this._interval
      ? g.setInterval(() => this._fn(...this._args), this._ms)
      : g.setTimeout(() => this._fn(...this._args), this._ms);
    return this;
  }

  close(): void {
    if (this._id != null) {
      if (this._interval) g.clearInterval(this._id);
      else g.clearTimeout(this._id);
    }
    this._id = null;
  }

  /** Number coercion returns the underlying id (Node parity for `+timeout`). */
  [Symbol.toPrimitive](): number {
    return this._id as unknown as number;
  }
}

export function setTimeout(fn: (...args: unknown[]) => void, ms = 0, ...args: unknown[]): Timer {
  return new Timer(fn, ms, args, false);
}

export function setInterval(fn: (...args: unknown[]) => void, ms = 0, ...args: unknown[]): Timer {
  return new Timer(fn, ms, args, true);
}

export function clearTimeout(t: Timer | number | undefined | null): void {
  if (t == null) return;
  if (t instanceof Timer) t.close();
  else g.clearTimeout(t);
}

export function clearInterval(t: Timer | number | undefined | null): void {
  if (t == null) return;
  if (t instanceof Timer) t.close();
  else g.clearInterval(t);
}

export function setImmediate(fn: (...args: unknown[]) => void, ...args: unknown[]): Timer {
  return new Timer(fn, 0, args, false);
}

export function clearImmediate(t: Timer | number | undefined | null): void {
  clearTimeout(t);
}

export default { setTimeout, setInterval, clearTimeout, clearInterval, setImmediate, clearImmediate };
