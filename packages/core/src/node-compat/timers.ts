// Node's `timers` module returns Timeout/Immediate objects with .ref()/.unref()/
// .refresh(), not the bare numeric id the browser's setTimeout returns. Code that
// does `require('timers').setTimeout(...).unref()` / `.refresh()` (e.g. Metro's
// metro-file-map DiskCacheManager) needs those methods, so wrap the global timers.
//
// Where the host has Node's event loop (a box on Node.js), a Timer wraps the host's own timer.
// In a browser it's a task on Lifo's event loop (event-loop.ts), which runs timers and
// immediates in Node's order.
import type { ActivityTracker } from './activity.js';
import { bindToFrame } from './async-context.js';
import { hostHasNodeLoop, addTimer, addImmediate, cancel, retime, type LoopTask } from './event-loop.js';

const g = globalThis as unknown as {
  setTimeout: (fn: () => void, ms: number) => unknown;
  setInterval: (fn: () => void, ms: number) => unknown;
  setImmediate: (fn: () => void) => unknown;
  clearTimeout: (id: unknown) => void;
  clearInterval: (id: unknown) => void;
  clearImmediate: (id: unknown) => void;
};

export const _setTimeout = globalThis.setTimeout;
export const _setInterval = globalThis.setInterval;
export const _clearTimeout = globalThis.clearTimeout;
export const _clearInterval = globalThis.clearInterval;

type Kind = 'timeout' | 'interval' | 'immediate';

/** Pending timers on Lifo's loop by their number form, for clearTimeout(+timer). */
const byId = new Map<number, Timer>();

class Timer {
  /** The host's timer (Node's Timeout or Immediate), where the host has Node's loop. */
  private _handle: unknown = null;
  /** The task on Lifo's loop, elsewhere. */
  private _task: LoopTask | null = null;
  private readonly _fn: (...args: unknown[]) => void;
  private readonly _ms: number;
  private readonly _args: unknown[];
  private readonly _kind: Kind;
  private readonly _tracker?: ActivityTracker;
  private _ref = true;
  /** Ends this timer's entry in the run's tracker; set while it's pending and ref'd. */
  private _done: (() => void) | null = null;

  constructor(fn: (...args: unknown[]) => void, ms: number, args: unknown[], kind: Kind, tracker?: ActivityTracker) {
    // Runs in the async context it was scheduled in, as in Node (AsyncLocalStorage).
    this._fn = bindToFrame(fn);
    this._ms = Number(ms) || 0;
    this._args = args;
    this._kind = kind;
    this._tracker = tracker;
    this._schedule();
    this._track();
  }

  private _pending(): boolean {
    return this._handle != null || this._task != null;
  }

  private _schedule(): void {
    if (hostHasNodeLoop) {
      const fire = () => this._fire();
      this._handle = this._kind === 'interval' ? g.setInterval(fire, this._ms)
        : this._kind === 'immediate' ? g.setImmediate(fire)
        : g.setTimeout(fire, this._ms);
      return;
    }
    const fire = () => this._fire();
    this._task = this._kind === 'immediate' ? addImmediate(fire) : addTimer(fire, this._ms);
    byId.set(this._task.id, this);
  }

  private _fire(): void {
    if (this._kind === 'interval') {
      // An interval runs again `ms` after this run starts; clearInterval inside the callback
      // stops it (the callback sees it pending, as in Node).
      if (!hostHasNodeLoop && this._task) {
        byId.delete(this._task.id);
        this._schedule();
      }
      this._fn(...this._args);
      return;
    }
    // A one-shot timer stops being pending once it fires, before its callback runs,
    // so a callback that schedules a new timer is counted by that one.
    if (this._task) byId.delete(this._task.id);
    this._handle = null;
    this._task = null;
    this._untrack();
    this._fn(...this._args);
  }

  /** Pending and ref'd timers keep the run alive, as in Node. */
  private _track(): void {
    if (this._tracker && this._ref && this._pending() && !this._done) this._done = this._tracker.begin();
  }

  private _untrack(): void {
    this._done?.();
    this._done = null;
  }

  ref(): this { this._ref = true; this._track(); return this; }
  unref(): this { this._ref = false; this._untrack(); return this; }
  hasRef(): boolean { return this._ref; }

  refresh(): this {
    if (this._kind === 'immediate') return this;
    this.close();
    this._schedule();
    this._track();
    return this;
  }

  close(): void {
    if (this._handle != null) {
      if (this._kind === 'interval') g.clearInterval(this._handle);
      else if (this._kind === 'immediate') g.clearImmediate(this._handle);
      else g.clearTimeout(this._handle);
    }
    if (this._task) {
      cancel(this._task);
      byId.delete(this._task.id);
    }
    this._handle = null;
    this._task = null;
    this._untrack();
  }

  /**
   * When the timer was started, in loop time (ms). Node.js aligns the timers of a render
   * stage by writing it (Next.js's atomic timer groups), so it's writable here too.
   */
  get _idleStart(): number | undefined {
    if (this._task) return this._task.start;
    const h = this._handle as { _idleStart?: number } | null;
    return h && typeof h === 'object' ? h._idleStart : undefined;
  }

  set _idleStart(start: number | undefined) {
    if (typeof start !== 'number') return;
    if (this._task) retime(this._task, start);
    else if (this._handle && typeof this._handle === 'object') (this._handle as { _idleStart?: number })._idleStart = start;
  }

  get _idleTimeout(): number {
    return this._pending() ? (this._kind === 'immediate' ? -1 : this._ms) : -1;
  }

  /** Number coercion gives an id clearTimeout accepts (Node parity for `+timeout`). */
  [Symbol.toPrimitive](): number {
    if (this._task) return this._task.id;
    return Number(this._handle);
  }
}

/** Stops a Timer, or a timer given by its number form or by the host's own id. */
function clearAny(t: unknown, hostClear: (id: unknown) => void): void {
  if (t == null) return;
  if (t instanceof Timer) { t.close(); return; }
  if (typeof t === 'number' && byId.has(t)) { byId.get(t)!.close(); return; }
  hostClear(t);
}

export function setTimeout(fn: (...args: unknown[]) => void, ms = 0, ...args: unknown[]): Timer {
  return new Timer(fn, ms, args, 'timeout');
}

export function setInterval(fn: (...args: unknown[]) => void, ms = 0, ...args: unknown[]): Timer {
  return new Timer(fn, ms, args, 'interval');
}

export function clearTimeout(t: Timer | number | undefined | null): void {
  clearAny(t, (id) => g.clearTimeout(id));
}

export function clearInterval(t: Timer | number | undefined | null): void {
  clearAny(t, (id) => g.clearInterval(id));
}

export function setImmediate(fn: (...args: unknown[]) => void, ...args: unknown[]): Timer {
  return new Timer(fn, 0, args, 'immediate');
}

export function clearImmediate(t: Timer | number | undefined | null): void {
  clearAny(t, (id) => (typeof g.clearImmediate === 'function' ? g.clearImmediate(id) : g.clearTimeout(id)));
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
    setTimeout: (fn, ms = 0, ...args) => new Timer(fn, ms, args, 'timeout', tracker),
    setInterval: (fn, ms = 0, ...args) => new Timer(fn, ms, args, 'interval', tracker),
    setImmediate: (fn, ...args) => new Timer(fn, 0, args, 'immediate', tracker),
    clearTimeout,
    clearInterval,
    clearImmediate,
  };
}

function abortError(signal?: AbortSignal): Error {
  const err = new Error('The operation was aborted') as Error & { code: string; cause?: unknown };
  err.name = 'AbortError';
  err.code = 'ABORT_ERR';
  err.cause = signal?.reason;
  return err;
}

interface TimerPromiseOptions {
  signal?: AbortSignal;
  ref?: boolean;
}

/**
 * `timers/promises` over a run's timers (so a pending `await setTimeout(…)` keeps the run
 * alive, and `{ ref: false }` doesn't). Vite 8 imports it.
 */
export function createTimersPromises(t: NodeTimers) {
  function delay<T>(ms: number, value: T, options: TimerPromiseOptions | undefined, immediate: boolean): Promise<T> {
    const signal = options?.signal;
    if (signal?.aborted) return Promise.reject(abortError(signal));
    return new Promise<T>((resolve, reject) => {
      const onAbort = () => {
        t.clearTimeout(timer);
        reject(abortError(signal));
      };
      const done = () => {
        signal?.removeEventListener('abort', onAbort);
        resolve(value);
      };
      const timer = immediate ? t.setImmediate(done) : t.setTimeout(done, ms);
      if (options?.ref === false) timer.unref();
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  async function* setInterval<T>(ms = 0, value?: T, options?: TimerPromiseOptions): AsyncGenerator<T | undefined> {
    const signal = options?.signal;
    if (signal?.aborted) throw abortError(signal);
    let ticks = 0;
    let wake: (() => void) | null = null;
    const timer = t.setInterval(() => {
      ticks++;
      wake?.();
    }, ms);
    if (options?.ref === false) timer.unref();
    const onAbort = () => wake?.();
    signal?.addEventListener('abort', onAbort);
    try {
      for (;;) {
        if (ticks === 0) await new Promise<void>((r) => { wake = r; });
        wake = null;
        if (signal?.aborted) throw abortError(signal);
        ticks--;
        yield value;
      }
    } finally {
      t.clearInterval(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }

  return {
    setTimeout: <T = void>(ms = 0, value?: T, options?: TimerPromiseOptions) => delay(ms, value as T, options, false),
    setImmediate: <T = void>(value?: T, options?: TimerPromiseOptions) => delay(0, value as T, options, true),
    setInterval,
    scheduler: {
      wait: (ms: number, options?: TimerPromiseOptions) => delay(ms, undefined, options, false),
      yield: () => delay(0, undefined, undefined, true),
    },
  };
}
