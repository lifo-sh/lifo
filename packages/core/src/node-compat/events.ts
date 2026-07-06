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

export default EventEmitter;
