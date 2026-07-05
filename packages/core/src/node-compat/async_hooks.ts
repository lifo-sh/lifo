// Minimal `async_hooks` shim. There is no real async-context tracking in the
// browser, so AsyncLocalStorage propagates its store synchronously within
// run()/enterWith(); context is not carried across independent await points.
// This is sufficient for consumers like undici that read the store defensively.

export class AsyncLocalStorage<T = unknown> {
  private _store: T | undefined = undefined;
  private _hasStore = false;

  run<R>(store: T, callback: (...args: unknown[]) => R, ...args: unknown[]): R {
    const prevStore = this._store;
    const prevHas = this._hasStore;
    this._store = store;
    this._hasStore = true;
    try {
      return callback(...args);
    } finally {
      this._store = prevStore;
      this._hasStore = prevHas;
    }
  }

  getStore(): T | undefined {
    return this._hasStore ? this._store : undefined;
  }

  enterWith(store: T): void {
    this._store = store;
    this._hasStore = true;
  }

  exit<R>(callback: (...args: unknown[]) => R, ...args: unknown[]): R {
    const prevStore = this._store;
    const prevHas = this._hasStore;
    this._store = undefined;
    this._hasStore = false;
    try {
      return callback(...args);
    } finally {
      this._store = prevStore;
      this._hasStore = prevHas;
    }
  }

  disable(): void {
    this._store = undefined;
    this._hasStore = false;
  }

  static bind<F extends (...args: unknown[]) => unknown>(fn: F): F {
    return fn;
  }

  static snapshot(): <R>(fn: (...args: unknown[]) => R, ...args: unknown[]) => R {
    return (fn, ...args) => fn(...args);
  }
}

export class AsyncResource {
  readonly type: string;
  constructor(type: string, _opts?: unknown) {
    this.type = type;
  }
  runInAsyncScope<R>(fn: (...args: unknown[]) => R, thisArg?: unknown, ...args: unknown[]): R {
    return fn.apply(thisArg, args);
  }
  bind<F extends (...args: unknown[]) => unknown>(fn: F): F {
    return fn;
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
  static bind<F extends (...args: unknown[]) => unknown>(fn: F): F {
    return fn;
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
