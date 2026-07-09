/**
 * Node.js `dgram` (UDP sockets) shim for Lifo.
 *
 * The browser has no UDP, so there is nothing to bind or send. This provides a
 * no-op Socket that settles its lifecycle events asynchronously (never hangs)
 * so libraries that open a socket degrade gracefully instead of crashing on a
 * missing module or waiting forever. Notably `@expo/cli`'s Bonjour/mDNS
 * advertising (dnssd-advertise, enabled by default in SDK 57's `expo start`)
 * requires `node:dgram`; without this shim `expo start --web` throws
 * "Cannot find module 'dgram'" during startup and never comes up.
 */

import { EventEmitter } from './events.js';

type MaybeCb = ((err?: Error | null) => void) | undefined;
const lastFn = (args: unknown[]): MaybeCb =>
  (typeof args[args.length - 1] === 'function' ? args[args.length - 1] : undefined) as MaybeCb;

export class Socket extends EventEmitter {
  private _bound = false;

  bind(...args: unknown[]): this {
    const cb = lastFn(args);
    queueMicrotask(() => {
      if (this._bound) return;
      this._bound = true;
      this.emit('listening');
      cb?.();
    });
    return this;
  }

  send(...args: unknown[]): this {
    // Signature ends with an optional callback: send(msg[,offset,length][,port][,address][,cb]).
    const cb = lastFn(args);
    if (cb) queueMicrotask(() => cb(null));
    return this;
  }

  close(cb?: () => void): this {
    queueMicrotask(() => {
      this.emit('close');
      cb?.();
    });
    return this;
  }

  address(): { address: string; family: string; port: number } {
    return { address: '0.0.0.0', family: 'IPv4', port: 0 };
  }

  // Multicast / socket-option setters — all no-ops in a browser.
  setMulticastTTL(): this { return this; }
  setMulticastLoopback(): this { return this; }
  setMulticastInterface(): this { return this; }
  addMembership(): this { return this; }
  dropMembership(): this { return this; }
  addSourceSpecificMembership(): this { return this; }
  dropSourceSpecificMembership(): this { return this; }
  setBroadcast(): this { return this; }
  setTTL(): this { return this; }
  setRecvBufferSize(): this { return this; }
  setSendBufferSize(): this { return this; }
  getRecvBufferSize(): number { return 0; }
  getSendBufferSize(): number { return 0; }
  connect(...args: unknown[]): this {
    const cb = lastFn(args);
    queueMicrotask(() => { this.emit('connect'); cb?.(); });
    return this;
  }
  disconnect(): this { return this; }
  ref(): this { return this; }
  unref(): this { return this; }
}

export function createSocket(
  _typeOrOptions: string | { type?: string } | undefined,
  onMessage?: (...a: unknown[]) => void,
): Socket {
  const socket = new Socket();
  if (typeof onMessage === 'function') socket.on('message', onMessage);
  return socket;
}

export default { createSocket, Socket };
