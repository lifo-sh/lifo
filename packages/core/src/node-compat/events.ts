// Node's EventEmitter is a plain function constructor, not an ES6 class. Some
// packages (e.g. queue@6 via image-size) use the classic inheritance pattern
// `EventEmitter.call(this)` / `inherits(Sub, EventEmitter)`, which the language
// forbids on an ES6 class ("Class constructor cannot be invoked without 'new'").
// So we implement it as a function constructor with prototype methods. It is
// still `new`-able and extendable by our ES6 stream classes (`class Readable
// extends EventEmitter`).

type Listener = (...args: unknown[]) => void;

export interface EventEmitter {
  _events: Map<string, Listener[]>;
  _maxListeners: number;
  on(event: string, listener: Listener): this;
  addListener(event: string, listener: Listener): this;
  once(event: string, listener: Listener): this;
  emit(event: string, ...args: unknown[]): boolean;
  removeListener(event: string, listener: Listener): this;
  off(event: string, listener: Listener): this;
  removeAllListeners(event?: string): this;
  listenerCount(event: string): number;
  listeners(event: string): Listener[];
  rawListeners(event: string): Listener[];
  setMaxListeners(n: number): this;
  getMaxListeners(): number;
  eventNames(): string[];
  prependListener(event: string, listener: Listener): this;
  prependOnceListener(event: string, listener: Listener): this;
}

interface EventEmitterConstructor {
  new (): EventEmitter;
  (this: EventEmitter): void;
  prototype: EventEmitter;
  defaultMaxListeners: number;
}

export const EventEmitter = function (this: EventEmitter): void {
  // Works whether invoked via `new`, `super()`, or `EventEmitter.call(this)`.
  if (!this._events) this._events = new Map();
  if (this._maxListeners === undefined) this._maxListeners = 10;
} as unknown as EventEmitterConstructor;

EventEmitter.defaultMaxListeners = 10;

function events(self: EventEmitter): Map<string, Listener[]> {
  if (!self._events) self._events = new Map();
  return self._events;
}

const proto = EventEmitter.prototype;

proto.on = function on(this: EventEmitter, event: string, listener: Listener): EventEmitter {
  const map = events(this);
  let list = map.get(event);
  if (!list) { list = []; map.set(event, list); }
  list.push(listener);
  return this;
};

proto.addListener = function addListener(this: EventEmitter, event: string, listener: Listener): EventEmitter {
  return this.on(event, listener);
};

proto.once = function once(this: EventEmitter, event: string, listener: Listener): EventEmitter {
  const self = this;
  const wrapped = function (this: unknown, ...args: unknown[]) {
    self.removeListener(event, wrapped);
    listener.apply(this, args);
  };
  (wrapped as { _original?: Listener })._original = listener;
  return this.on(event, wrapped);
};

proto.prependOnceListener = function prependOnceListener(this: EventEmitter, event: string, listener: Listener): EventEmitter {
  const self = this;
  const wrapped = function (this: unknown, ...args: unknown[]) {
    self.removeListener(event, wrapped);
    listener.apply(this, args);
  };
  (wrapped as { _original?: Listener })._original = listener;
  return this.prependListener(event, wrapped);
};

proto.emit = function emit(this: EventEmitter, event: string, ...args: unknown[]): boolean {
  const list = events(this).get(event);
  if (!list || list.length === 0) return false;
  for (const fn of [...list]) fn.apply(this, args);
  return true;
};

function removeImpl(self: EventEmitter, event: string, listener: Listener): EventEmitter {
  const list = events(self).get(event);
  if (!list) return self;
  const idx = list.findIndex(
    (fn) => fn === listener || (fn as { _original?: unknown })._original === listener,
  );
  if (idx !== -1) list.splice(idx, 1);
  if (list.length === 0) events(self).delete(event);
  return self;
}

// `off` and `removeListener` both do the removal directly (in Node they are the
// same function). A subclass that overrides `off` to call `super.off()` while
// aliasing `removeListener` to `this.off()` (minipass) would otherwise recurse.
proto.removeListener = function removeListener(this: EventEmitter, event: string, listener: Listener): EventEmitter {
  return removeImpl(this, event, listener);
};

proto.off = function off(this: EventEmitter, event: string, listener: Listener): EventEmitter {
  return removeImpl(this, event, listener);
};

proto.removeAllListeners = function removeAllListeners(this: EventEmitter, event?: string): EventEmitter {
  if (event !== undefined) events(this).delete(event);
  else events(this).clear();
  return this;
};

proto.listenerCount = function listenerCount(this: EventEmitter, event: string): number {
  return events(this).get(event)?.length ?? 0;
};

proto.listeners = function listeners(this: EventEmitter, event: string): Listener[] {
  return [...(events(this).get(event) ?? [])].map(
    (fn) => (fn as { _original?: Listener })._original ?? fn,
  );
};

proto.rawListeners = function rawListeners(this: EventEmitter, event: string): Listener[] {
  return [...(events(this).get(event) ?? [])];
};

proto.setMaxListeners = function setMaxListeners(this: EventEmitter, n: number): EventEmitter {
  this._maxListeners = n;
  return this;
};

proto.getMaxListeners = function getMaxListeners(this: EventEmitter): number {
  return this._maxListeners ?? 10;
};

proto.eventNames = function eventNames(this: EventEmitter): string[] {
  return [...events(this).keys()];
};

proto.prependListener = function prependListener(this: EventEmitter, event: string, listener: Listener): EventEmitter {
  const map = events(this);
  let list = map.get(event);
  if (!list) { list = []; map.set(event, list); }
  list.unshift(listener);
  return this;
};

type Emitterish = {
  on?(event: string, fn: Listener): unknown;
  off?(event: string, fn: Listener): unknown;
  removeListener?(event: string, fn: Listener): unknown;
  addEventListener?(event: string, fn: (e: unknown) => void, opts?: unknown): unknown;
  removeEventListener?(event: string, fn: (e: unknown) => void): unknown;
};

/**
 * events.once(emitter, name): a promise of the event's arguments; an 'error' first rejects it.
 * Works with EventEmitters and EventTargets, and takes { signal } like Node's.
 */
export function once(emitter: Emitterish, name: string, options?: { signal?: AbortSignal }): Promise<unknown[]> {
  return new Promise((resolve, reject) => {
    const signal = options?.signal;
    if (signal?.aborted) {
      reject(Object.assign(new Error('The operation was aborted'), { name: 'AbortError', code: 'ABORT_ERR', cause: signal.reason }));
      return;
    }
    const off = (event: string, fn: Listener) => (emitter.off ?? emitter.removeListener)?.call(emitter, event, fn);
    const cleanup = () => {
      if (emitter.on) {
        off(name, onEvent);
        if (name !== 'error') off('error', onError);
      } else {
        emitter.removeEventListener?.(name, onTargetEvent);
      }
      signal?.removeEventListener('abort', onAbort);
    };
    const onEvent: Listener = (...args) => { cleanup(); resolve(args); };
    const onError: Listener = (err) => { cleanup(); reject(err); };
    const onTargetEvent = (event: unknown) => { cleanup(); resolve([event]); };
    const onAbort = () => {
      cleanup();
      reject(Object.assign(new Error('The operation was aborted'), { name: 'AbortError', code: 'ABORT_ERR', cause: signal?.reason }));
    };
    if (emitter.on) {
      emitter.on(name, onEvent);
      if (name !== 'error') emitter.on('error', onError);
    } else {
      emitter.addEventListener?.(name, onTargetEvent);
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

const abortError = (signal?: AbortSignal) =>
  Object.assign(new Error('The operation was aborted'), { name: 'AbortError', code: 'ABORT_ERR', cause: signal?.reason });

/**
 * events.on(emitter, name): an async iterator of the event's argument lists, until the
 * iteration stops; an 'error' event ends it with that error. Takes { signal } like Node's.
 */
export function on(emitter: Emitterish, name: string, options?: { signal?: AbortSignal; close?: string[] }): AsyncIterableIterator<unknown[]> {
  const signal = options?.signal;
  const queue: unknown[][] = [];
  const waiting: Array<{ resolve(r: IteratorResult<unknown[]>): void; reject(e: unknown): void }> = [];
  let failure: unknown = null;
  let done = false;
  const off = (event: string, fn: Listener) => (emitter.off ?? emitter.removeListener)?.call(emitter, event, fn);
  const finish = () => {
    if (done) return;
    done = true;
    if (emitter.on) {
      off(name, onEvent);
      if (name !== 'error') off('error', onError);
      for (const c of options?.close ?? []) off(c, onClose);
    } else {
      emitter.removeEventListener?.(name, onTargetEvent);
    }
    signal?.removeEventListener('abort', onAbort);
  };
  const deliver = (args: unknown[]) => {
    const w = waiting.shift();
    if (w) w.resolve({ value: args, done: false });
    else queue.push(args);
  };
  const fail = (err: unknown) => {
    finish();
    const w = waiting.shift();
    if (w) w.reject(err);
    else failure = err;
    for (const rest of waiting.splice(0)) rest.resolve({ value: undefined, done: true });
  };
  const onEvent: Listener = (...args) => deliver(args);
  const onTargetEvent = (event: unknown) => deliver([event]);
  const onError: Listener = (err) => fail(err);
  const onClose: Listener = () => {
    finish();
    for (const w of waiting.splice(0)) w.resolve({ value: undefined, done: true });
  };
  const onAbort = () => fail(abortError(signal));
  if (signal?.aborted) {
    failure = abortError(signal);
    done = true;
  } else if (emitter.on) {
    emitter.on(name, onEvent);
    if (name !== 'error') emitter.on('error', onError);
    for (const c of options?.close ?? []) emitter.on(c, onClose);
  } else {
    emitter.addEventListener?.(name, onTargetEvent);
  }
  signal?.addEventListener('abort', onAbort, { once: true });
  const iterator: AsyncIterableIterator<unknown[]> = {
    next() {
      if (queue.length > 0) return Promise.resolve({ value: queue.shift()!, done: false });
      if (failure) {
        const err = failure;
        failure = null;
        return Promise.reject(err);
      }
      if (done) return Promise.resolve({ value: undefined, done: true });
      return new Promise((resolve, reject) => waiting.push({ resolve, reject }));
    },
    return() {
      finish();
      for (const w of waiting.splice(0)) w.resolve({ value: undefined, done: true });
      return Promise.resolve({ value: undefined, done: true });
    },
    throw(err: unknown) {
      fail(err);
      return Promise.reject(err);
    },
    [Symbol.asyncIterator]() { return iterator; },
  };
  return iterator;
}

/** events.setMaxListeners(n, ...targets): on each emitter given, or the default for new ones. */
export function setMaxListeners(n: number, ...targets: Array<{ setMaxListeners?(n: number): unknown }>): void {
  if (targets.length === 0) {
    (EventEmitter as unknown as { defaultMaxListeners: number }).defaultMaxListeners = n;
    return;
  }
  for (const t of targets) t?.setMaxListeners?.(n); // an EventTarget has no limit to set
}

/** events.getEventListeners(emitter, name): the listeners an emitter has for the event. */
export function getEventListeners(emitter: { listeners?(name: string): Listener[] }, name: string): Listener[] {
  return emitter?.listeners ? emitter.listeners(name) : [];
}

/**
 * events.addAbortListener(signal, listener): listens for the abort once (now, if the signal is
 * already aborted); the returned object's [Symbol.dispose]() stops listening.
 */
export function addAbortListener(signal: AbortSignal, listener: (e: Event) => void): { [Symbol.dispose](): void } {
  if (signal.aborted) queueMicrotask(() => listener(new Event('abort')));
  else signal.addEventListener('abort', listener, { once: true });
  const dispose = Symbol.dispose ?? Symbol.for('nodejs.dispose');
  return { [dispose]: () => signal.removeEventListener('abort', listener) } as { [Symbol.dispose](): void };
}

export default EventEmitter;
