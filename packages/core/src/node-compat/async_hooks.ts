// `async_hooks`: AsyncLocalStorage and AsyncResource on Lifo's async context (async-context.ts),
// which carries the active stores across await, promise callbacks, timers and nextTick.
import { activateAsyncContext, bindToFrame, currentFrame, runInFrame, setFrame, type Frame } from './async-context.js';

const withStore = (frame: Frame, key: object, store: unknown): Frame => new Map(frame).set(key, store);
const withoutStore = (frame: Frame, key: object): Frame => {
  if (!frame?.has(key)) return frame;
  const next = new Map(frame);
  next.delete(key);
  return next.size > 0 ? next : undefined;
};

export class AsyncLocalStorage<T = unknown> {
  run<R>(store: T, callback: (...args: unknown[]) => R, ...args: unknown[]): R {
    activateAsyncContext();
    return runInFrame(withStore(currentFrame(), this, store), callback, undefined, args);
  }

  getStore(): T | undefined {
    return currentFrame()?.get(this) as T | undefined;
  }

  /** The store for the rest of this synchronous run and the async work it starts. */
  enterWith(store: T): void {
    activateAsyncContext();
    setFrame(withStore(currentFrame(), this, store));
  }

  exit<R>(callback: (...args: unknown[]) => R, ...args: unknown[]): R {
    return runInFrame(withoutStore(currentFrame(), this), callback, undefined, args);
  }

  disable(): void {
    setFrame(withoutStore(currentFrame(), this));
  }

  /** `fn`, run in the context active now whenever it's called. */
  static bind<F extends (...args: unknown[]) => unknown>(fn: F): F {
    return bindToFrame(fn);
  }

  /** A function that runs any function in the context active now. */
  static snapshot(): <R>(fn: (...args: unknown[]) => R, ...args: unknown[]) => R {
    const frame = currentFrame();
    return (fn, ...args) => runInFrame(frame, fn, undefined, args);
  }
}

export class AsyncResource {
  readonly type: string;
  private readonly frame: Frame = currentFrame();
  constructor(type: string, _opts?: unknown) {
    this.type = type;
  }
  runInAsyncScope<R>(fn: (...args: unknown[]) => R, thisArg?: unknown, ...args: unknown[]): R {
    return runInFrame(this.frame, fn, thisArg, args);
  }
  bind<F extends (...args: unknown[]) => unknown>(fn: F): F {
    const bound = (...args: unknown[]) => this.runInAsyncScope(fn, undefined, ...args);
    return bound as F;
  }
  emitDestroy(): this {
    return this;
  }
  asyncId(): number {
    return 0;
  }
  triggerAsyncId(): number {
    return 0;
  }
  static bind<F extends (...args: unknown[]) => unknown>(fn: F, type = 'bound-anonymous-fn'): F {
    return new AsyncResource(type).bind(fn);
  }
}

export function createHook(_callbacks: unknown): { enable(): unknown; disable(): unknown } {
  const hook = {
    enable() { return hook; },
    disable() { return hook; },
  };
  return hook;
}

export function executionAsyncId(): number {
  return 1;
}

export function triggerAsyncId(): number {
  return 0;
}

export function executionAsyncResource(): object {
  return {};
}

export default {
  AsyncLocalStorage,
  AsyncResource,
  createHook,
  executionAsyncId,
  triggerAsyncId,
  executionAsyncResource,
};
