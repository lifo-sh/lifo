// Minimal `diagnostics_channel` implementation. undici (used by fetch) requires
// it at load time; most consumers gate publishes on `hasSubscribers`, so a
// faithful pub/sub with no-op-ish tracing is sufficient.

type MessageHandler = (message: unknown, name: string | symbol) => void;

export class Channel {
  readonly name: string | symbol;
  private _subscribers = new Set<MessageHandler>();

  constructor(name: string | symbol) {
    this.name = name;
  }

  get hasSubscribers(): boolean {
    return this._subscribers.size > 0;
  }

  publish(message: unknown): void {
    for (const fn of this._subscribers) {
      try {
        fn(message, this.name);
      } catch {
        /* subscriber errors must not break the publisher */
      }
    }
  }

  subscribe(onMessage: MessageHandler): void {
    this._subscribers.add(onMessage);
  }

  unsubscribe(onMessage: MessageHandler): boolean {
    return this._subscribers.delete(onMessage);
  }
}

const channels = new Map<string | symbol, Channel>();

export function channel(name: string | symbol): Channel {
  let c = channels.get(name);
  if (!c) {
    c = new Channel(name);
    channels.set(name, c);
  }
  return c;
}

export function hasSubscribers(name: string | symbol): boolean {
  const c = channels.get(name);
  return !!c && c.hasSubscribers;
}

export function subscribe(name: string | symbol, onMessage: MessageHandler): void {
  channel(name).subscribe(onMessage);
}

export function unsubscribe(name: string | symbol, onMessage: MessageHandler): boolean {
  return channel(name).unsubscribe(onMessage);
}

type TracingHandlers = Record<string, MessageHandler>;

export class TracingChannel {
  readonly start: Channel;
  readonly end: Channel;
  readonly asyncStart: Channel;
  readonly asyncEnd: Channel;
  readonly error: Channel;

  constructor(name: string) {
    this.start = channel(`tracing:${name}:start`);
    this.end = channel(`tracing:${name}:end`);
    this.asyncStart = channel(`tracing:${name}:asyncStart`);
    this.asyncEnd = channel(`tracing:${name}:asyncEnd`);
    this.error = channel(`tracing:${name}:error`);
  }

  get hasSubscribers(): boolean {
    return (
      this.start.hasSubscribers || this.end.hasSubscribers ||
      this.asyncStart.hasSubscribers || this.asyncEnd.hasSubscribers ||
      this.error.hasSubscribers
    );
  }

  subscribe(handlers: TracingHandlers): void {
    for (const key of Object.keys(handlers)) {
      (this as unknown as Record<string, Channel>)[key]?.subscribe(handlers[key]);
    }
  }

  unsubscribe(handlers: TracingHandlers): boolean {
    let ok = true;
    for (const key of Object.keys(handlers)) {
      const ch = (this as unknown as Record<string, Channel>)[key];
      if (!ch || !ch.unsubscribe(handlers[key])) ok = false;
    }
    return ok;
  }

  traceSync<T>(fn: (...a: unknown[]) => T, _context?: unknown, thisArg?: unknown, ...args: unknown[]): T {
    return fn.apply(thisArg, args);
  }

  tracePromise<T>(fn: (...a: unknown[]) => Promise<T>, _context?: unknown, thisArg?: unknown, ...args: unknown[]): Promise<T> {
    return fn.apply(thisArg, args);
  }

  traceCallback(fn: (...a: unknown[]) => unknown, _position?: number, _context?: unknown, thisArg?: unknown, ...args: unknown[]): unknown {
    return fn.apply(thisArg, args);
  }
}

export function tracingChannel(nameOrChannels: string | Record<string, unknown>): TracingChannel {
  return new TracingChannel(typeof nameOrChannels === 'string' ? nameOrChannels : 'custom');
}

export default { channel, hasSubscribers, subscribe, unsubscribe, tracingChannel, Channel, TracingChannel };
