// Node's `timers` module returns Timeout/Immediate objects with .ref()/.unref()/
// .refresh(), not the bare numeric id the browser's setTimeout returns. Code that
// does `require('timers').setTimeout(...).unref()` / `.refresh()` (e.g. Metro's
// metro-file-map DiskCacheManager) needs those methods, so wrap the global timers.
import type { ActivityTracker } from './activity.js';

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
  private readonly _tracker?: ActivityTracker;
  private _ref = true;
  /** Ends this timer's entry in the run's tracker; set while it's pending and ref'd. */
  private _done: (() => void) | null = null;

  constructor(fn: (...args: unknown[]) => void, ms: number, args: unknown[], interval: boolean, tracker?: ActivityTracker) {
    this._fn = fn;
    this._ms = ms;
    this._args = args;
    this._interval = interval;
    this._tracker = tracker;
    this._id = this._schedule();
    this._track();
  }

  private _schedule(): ReturnType<typeof g.setTimeout> {
    return this._interval
      ? g.setInterval(() => this._fn(...this._args), this._ms)
      : g.setTimeout(() => {
          // A one-shot timer stops being pending once it fires, before its callback runs,
          // so a callback that schedules a new timer is counted by that one.
          this._id = null;
          this._untrack();
          this._fn(...this._args);
        }, this._ms);
  }

  /** Pending and ref'd timers keep the run alive, as in Node. */
  private _track(): void {
    if (this._tracker && this._ref && this._id != null && !this._done) this._done = this._tracker.begin();
  }

  private _untrack(): void {
    this._done?.();
    this._done = null;
  }

  ref(): this { this._ref = true; this._track(); return this; }
  unref(): this { this._ref = false; this._untrack(); return this; }
  hasRef(): boolean { return this._ref; }

  refresh(): this {
    this.close();
    this._id = this._schedule();
    this._track();
    return this;
  }

  close(): void {
    if (this._id != null) {
      if (this._interval) g.clearInterval(this._id);
      else g.clearTimeout(this._id);
    }
    this._id = null;
    this._untrack();
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

const timersApi = { setTimeout, setInterval, clearTimeout, clearInterval, setImmediate, clearImmediate };
export type NodeTimers = typeof timersApi;

/**
 * Timers for one `node` run: the same API, with every pending, ref'd timer counted in the run's
 * tracker, so the run doesn't end while the program still has a timer to fire.
 */
export function createTimers(tracker: ActivityTracker): NodeTimers {
  return {
    setTimeout: (fn, ms = 0, ...args) => new Timer(fn, ms, args, false, tracker),
    setInterval: (fn, ms = 0, ...args) => new Timer(fn, ms, args, true, tracker),
    setImmediate: (fn, ...args) => new Timer(fn, 0, args, false, tracker),
    clearTimeout,
    clearInterval,
    clearImmediate,
  };
}
