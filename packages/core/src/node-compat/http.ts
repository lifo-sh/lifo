import { EventEmitter } from './events.js';
import type { VirtualRequestHandler, VirtualResponse } from '../kernel/index.js';

/** Extended VirtualResponse with a done promise for async middleware */
export interface VirtualResponseWithDone extends VirtualResponse {
  _donePromise?: Promise<void>;
}

interface RequestOptions {
  hostname?: string;
  host?: string;
  port?: number | string;
  path?: string;
  method?: string;
  headers?: Record<string, string>;
  timeout?: number;
}

class IncomingMessage extends EventEmitter {
  statusCode: number;
  statusMessage: string;
  headers: Record<string, string>;
  method?: string;
  url?: string;
  httpVersion = '1.1';
  httpVersionMajor = 1;
  httpVersionMinor = 1;
  complete = false;
  aborted = false;
  readable = true;
  // Minimal socket stub that Vite/Connect middleware expects
  socket: {
    remoteAddress: string;
    remotePort: number;
    encrypted: boolean;
    destroy: () => void;
  };
  connection: {
    remoteAddress: string;
    encrypted: boolean;
  };

  constructor(statusCode: number, statusMessage: string, headers: Record<string, string>) {
    super();
    this.statusCode = statusCode;
    this.statusMessage = statusMessage;
    this.headers = headers;
    const socketStub = {
      remoteAddress: '127.0.0.1',
      remotePort: 0,
      encrypted: false,
      destroy: () => {},
    };
    this.socket = socketStub;
    this.connection = socketStub;
  }

  setEncoding(_enc: string): this {
    return this;
  }

  // Stream-like methods that middleware may call
  resume(): this {
    return this;
  }

  pause(): this {
    return this;
  }

  destroy(): this {
    this.aborted = true;
    return this;
  }
}

class ClientRequest extends EventEmitter {
  private options: RequestOptions;
  private body = '';
  private aborted = false;
  private portRegistry?: Map<number, VirtualRequestHandler>;
  private protocol: 'http:' | 'https:';

  constructor(options: RequestOptions, cb?: (res: IncomingMessage) => void, portRegistry?: Map<number, VirtualRequestHandler>, protocol: 'http:' | 'https:' = 'http:') {
    super();
    this.options = options;
    this.portRegistry = portRegistry;
    this.protocol = protocol;
    if (cb) this.on('response', cb as (...args: unknown[]) => void);

    // Defer the actual fetch
    queueMicrotask(() => this.execute());
  }

  write(data: string): void {
    this.body += data;
  }

  end(data?: string): void {
    if (data) this.body += data;
  }

  abort(): void {
    this.aborted = true;
  }

  private async execute(): Promise<void> {
    if (this.aborted) return;

    const host = this.options.hostname || this.options.host || 'localhost';
    const port = this.options.port ? Number(this.options.port) : undefined;
    const path = this.options.path || '/';

    // Check if target is a virtual server
    if (this.portRegistry && port && (host === 'localhost' || host === '127.0.0.1')) {
      const handler = this.portRegistry.get(port);
      if (handler) {
        const vReq = {
          method: this.options.method || 'GET',
          url: path,
          headers: this.options.headers || {},
          body: this.body,
        };
        const vRes = {
          statusCode: 200,
          headers: {} as Record<string, string>,
          body: '',
        };

        try {
          handler(vReq, vRes);

          const msg = new IncomingMessage(vRes.statusCode, 'OK', vRes.headers);
          this.emit('response', msg);

          queueMicrotask(() => {
            msg.emit('data', vRes.body);
            msg.emit('end');
          });
        } catch (e) {
          this.emit('error', e);
        }
        return;
      }
    }

    // Fall through to real fetch
    const proto = this.protocol.replace(':', ''); // 'http:' -> 'http' or 'https:' -> 'https'
    const portStr = this.options.port ? `:${this.options.port}` : '';
    const url = `${proto}://${host}${portStr}${path}`;

    try {
      const resp = await fetch(url, {
        method: this.options.method || 'GET',
        headers: this.options.headers,
        body: this.options.method !== 'GET' && this.body ? this.body : undefined,
      });

      const headers: Record<string, string> = {};
      resp.headers.forEach((v, k) => { headers[k] = v; });

      const msg = new IncomingMessage(resp.status, resp.statusText, headers);
      this.emit('response', msg);

      const text = await resp.text();
      msg.emit('data', text);
      msg.emit('end');
    } catch (e) {
      this.emit('error', e);
    }
  }

  setTimeout(_ms: number, cb?: () => void): this {
    if (cb) this.on('timeout', cb);
    return this;
  }
}

// --- ServerResponse class ---

class ServerResponse extends EventEmitter {
  statusCode = 200;
  statusMessage = 'OK';
  headersSent = false;
  finished = false;
  writableEnded = false;
  writableFinished = false;
  private _headers: Record<string, string | string[]> = {};
  // Accumulate raw byte chunks so binary responses (wasm, images, fonts) are
  // preserved. A string _body would corrupt them via UTF-8 round-tripping.
  private _chunks: Uint8Array[] = [];
  private _vRes: { statusCode: number; headers: Record<string, string>; body: string; bodyBytes?: Uint8Array };
  // Minimal socket stub that middleware may reference
  socket: { destroy: () => void; writable: boolean; readable: boolean; remoteAddress: string } | null;
  // Promise that resolves when end() is called (for async middleware)
  _donePromise: Promise<void>;
  private _doneResolve!: () => void;

  constructor(vRes: { statusCode: number; headers: Record<string, string>; body: string }) {
    super();
    this._vRes = vRes;
    this._donePromise = new Promise<void>((resolve) => {
      this._doneResolve = resolve;
    });
    // Socket stub that resolves _donePromise on destroy (error abort path)
    this.socket = {
      writable: true,
      readable: true,
      remoteAddress: '127.0.0.1',
      destroy: () => {
        this.socket!.writable = false;
        if (!this.finished) {
          this._vRes.statusCode = this.statusCode || 500;
          this._vRes.headers = {};
          this._vRes.body = '';
          this._vRes.bodyBytes = new Uint8Array(0);
          this.finished = true;
          this._doneResolve();
        }
      },
    };
  }

  writeHead(statusCode: number, reasonOrHeaders?: string | Record<string, string | string[]>, headers?: Record<string, string | string[]>): this {
    this.statusCode = statusCode;
    let h: Record<string, string | string[]> | undefined;
    if (typeof reasonOrHeaders === 'string') {
      this.statusMessage = reasonOrHeaders;
      h = headers;
    } else {
      h = reasonOrHeaders;
    }
    if (h) {
      for (const [k, v] of Object.entries(h)) {
        this._headers[k.toLowerCase()] = v;
      }
    }
    this.headersSent = true;
    return this;
  }

  setHeader(name: string, value: string | string[]): this {
    this._headers[name.toLowerCase()] = value;
    return this;
  }

  getHeader(name: string): string | string[] | undefined {
    return this._headers[name.toLowerCase()];
  }

  getHeaders(): Record<string, string | string[]> {
    return { ...this._headers };
  }

  getHeaderNames(): string[] {
    return Object.keys(this._headers);
  }

  hasHeader(name: string): boolean {
    return name.toLowerCase() in this._headers;
  }

  removeHeader(name: string): void {
    delete this._headers[name.toLowerCase()];
  }

  appendHeader(name: string, value: string | string[]): this {
    const key = name.toLowerCase();
    const existing = this._headers[key];
    if (existing === undefined) {
      this._headers[key] = value;
    } else if (Array.isArray(existing)) {
      this._headers[key] = existing.concat(value);
    } else {
      this._headers[key] = Array.isArray(value) ? [existing, ...value] : [existing, value];
    }
    return this;
  }

  flushHeaders(): void {
    this.headersSent = true;
  }

  write(data: string | Uint8Array): boolean {
    this._chunks.push(typeof data === 'string' ? this._enc.encode(data) : data);
    return true;
  }

  private _enc = new TextEncoder();

  end(data?: string | Uint8Array | (() => void), _encoding?: string, cb?: () => void): void {
    if (typeof data === 'function') {
      cb = data;
      data = undefined;
    }
    if (typeof data === 'string') {
      this._chunks.push(this._enc.encode(data));
    } else if (data instanceof Uint8Array) {
      this._chunks.push(data);
    }
    this.finished = true;
    this.writableEnded = true;
    this.writableFinished = true;
    // Flatten header arrays to comma-separated strings for the virtual response
    const flatHeaders: Record<string, string> = {};
    for (const [k, v] of Object.entries(this._headers)) {
      flatHeaders[k] = Array.isArray(v) ? v.join(', ') : v;
    }
    // Concatenate the byte chunks — binary-safe.
    let total = 0;
    for (const c of this._chunks) total += c.length;
    const bytes = new Uint8Array(total);
    let off = 0;
    for (const c of this._chunks) { bytes.set(c, off); off += c.length; }

    // Flush to virtual response: bodyBytes is canonical (binary-safe);
    // body is a best-effort text view for legacy string consumers.
    this._vRes.statusCode = this.statusCode;
    this._vRes.headers = flatHeaders;
    this._vRes.bodyBytes = bytes;
    this._vRes.body = new TextDecoder().decode(bytes);
    this.headersSent = true;
    this.emit('finish');
    this._doneResolve();
    if (cb) cb();
  }

  // Cork/uncork stubs (used by some frameworks)
  cork(): void {}
  uncork(): void {}
}

// --- Server class ---

// Symbol used to track active server promises on the http module instance
export const ACTIVE_SERVERS = Symbol.for('lifo.http.activeServers');

/**
 * Upgrade handlers, keyed by port, attached to the shared portRegistry map.
 * Consumers (the tunnel) invoke these with (req, socket, head) to deliver a
 * WebSocket upgrade into the virtual server — the Server re-emits 'upgrade',
 * which libraries like ws (bundled in Vite for HMR) listen on and then speak
 * the real WebSocket frame protocol over the provided socket object.
 */
export const UPGRADE_HANDLERS = Symbol.for('lifo.http.upgradeHandlers');

export type UpgradeHandler = (
  req: { method: string; url: string; headers: Record<string, string> },
  socket: unknown,
  head: Uint8Array,
) => boolean;

export function getUpgradeHandlers(portRegistry: Map<number, VirtualRequestHandler>): Map<number, UpgradeHandler> {
  const holder = portRegistry as unknown as Record<symbol, Map<number, UpgradeHandler>>;
  if (!holder[UPGRADE_HANDLERS]) holder[UPGRADE_HANDLERS] = new Map();
  return holder[UPGRADE_HANDLERS];
}

class Server extends EventEmitter {
  private portRegistry: Map<number, VirtualRequestHandler>;
  private _port: number | null = null;
  private _closeResolve: (() => void) | null = null;
  private _promise: Promise<void> | null = null;
  private _activeServers: Server[];

  constructor(
    portRegistry: Map<number, VirtualRequestHandler>,
    activeServers: Server[],
    requestHandler?: (req: unknown, res: unknown) => void,
  ) {
    super();
    this.portRegistry = portRegistry;
    this._activeServers = activeServers;
    if (requestHandler) {
      this.on('request', requestHandler as (...args: unknown[]) => void);
    }
  }

  listen(port: number, ...rest: unknown[]): this {
    let callback: (() => void) | undefined;
    for (const arg of rest) {
      if (typeof arg === 'function') {
        callback = arg as () => void;
        break;
      }
    }

    this._port = port;

    // Create a promise that resolves when server.close() is called
    this._promise = new Promise<void>((resolve) => {
      this._closeResolve = resolve;
    });

    // Debug logging
    console.log(`[lifo-http] Server.listen() called for port ${port}`);
    console.log(`[lifo-http] portRegistry exists: ${!!this.portRegistry}`);
    console.log(`[lifo-http] portRegistry is Map: ${this.portRegistry instanceof Map}`);

    // Register the handler in portRegistry
    const handler: VirtualRequestHandler = (vReq, vRes) => {
      const req = new IncomingMessage(0, '', vReq.headers);
      req.method = vReq.method;
      req.url = vReq.url;

      const res = new ServerResponse(vRes);
      // Attach the done promise to vRes so consumers (tunnel, curl) can await async middleware
      (vRes as VirtualResponseWithDone)._donePromise = res._donePromise;
      this.emit('request', req, res);

      // Emit body data + end so middleware that reads the request body works
      queueMicrotask(() => {
        if (vReq.body) {
          req.emit('data', vReq.body);
        }
        req.complete = true;
        req.emit('end');
      });
    };
    this.portRegistry.set(port, handler);
    console.log(`[lifo-http] ✅ Registered port ${port} in portRegistry (size: ${this.portRegistry.size})`);

    // WebSocket upgrade delivery (e.g. Vite's HMR server attaches an
    // 'upgrade' listener and runs the ws frame protocol over the socket).
    getUpgradeHandlers(this.portRegistry).set(port, (req, socket, head) => {
      if (this.listenerCount('upgrade') === 0) return false;
      const msg = new IncomingMessage(0, '', req.headers);
      msg.method = req.method;
      msg.url = req.url;
      this.emit('upgrade', msg, socket, head);
      return true;
    });

    // Track this server
    this._activeServers.push(this);

    // Emit 'listening' event asynchronously (like Node does) and call callback
    queueMicrotask(() => {
      this.emit('listening');
      if (callback) callback();
    });

    return this;
  }

  close(callback?: () => void): this {
    console.log(`[lifo-http] ❌ Server.close() called for port ${this._port}`);
    console.log(`[lifo-http] Stack trace:`, new Error().stack);

    if (this._port !== null) {
      this.portRegistry.delete(this._port);
      getUpgradeHandlers(this.portRegistry).delete(this._port);
      console.log(`[lifo-http] Deleted port ${this._port} from registry (size now: ${this.portRegistry.size})`);
    }

    // Remove from active servers list
    const idx = this._activeServers.indexOf(this);
    if (idx !== -1) this._activeServers.splice(idx, 1);

    if (this._closeResolve) {
      this._closeResolve();
      this._closeResolve = null;
    }

    if (callback) {
      queueMicrotask(callback);
    }

    this.emit('close');
    return this;
  }

  // Node 18.2+ graceful-shutdown helpers. There are no real sockets in the VM,
  // so these are no-ops (metro calls closeAllConnections when stopping its server).
  closeAllConnections(): void { /* no-op */ }
  closeIdleConnections(): void { /* no-op */ }

  address(): { port: number; address: string; family: string } | null {
    if (this._port === null) return null;
    return { port: this._port, address: '127.0.0.1', family: 'IPv4' };
  }

  getPromise(): Promise<void> | null {
    return this._promise;
  }
}

// --- Factory function ---

export function createHttp(portRegistry?: Map<number, VirtualRequestHandler>, protocol: 'http:' | 'https:' = 'http:') {
  // Track active servers created by this http module instance
  const activeServers: Server[] = [];

  function httpRequest(
    urlOrOptions: string | RequestOptions,
    optionsOrCb?: RequestOptions | ((res: IncomingMessage) => void),
    cb?: (res: IncomingMessage) => void,
  ): ClientRequest {
    let options: RequestOptions;
    let callback: ((res: IncomingMessage) => void) | undefined;

    if (typeof urlOrOptions === 'string') {
      const u = new URL(urlOrOptions);
      options = {
        hostname: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        method: 'GET',
      };
      if (typeof optionsOrCb === 'function') {
        callback = optionsOrCb;
      } else {
        options = { ...options, ...optionsOrCb };
        callback = cb;
      }
    } else {
      options = urlOrOptions;
      callback = optionsOrCb as ((res: IncomingMessage) => void) | undefined;
    }

    return new ClientRequest(options, callback, portRegistry, protocol);
  }

  function httpGet(
    urlOrOptions: string | RequestOptions,
    optionsOrCb?: RequestOptions | ((res: IncomingMessage) => void),
    cb?: (res: IncomingMessage) => void,
  ): ClientRequest {
    const req = httpRequest(urlOrOptions, optionsOrCb, cb);
    req.end();
    return req;
  }

  function httpCreateServer(requestHandler?: (req: unknown, res: unknown) => void): Server {
    if (!portRegistry) {
      throw new Error('http.createServer() is not supported in Lifo');
    }
    return new Server(portRegistry, activeServers, requestHandler);
  }

  const mod = {
    request: httpRequest,
    get: httpGet,
    createServer: httpCreateServer,
    IncomingMessage,
    ClientRequest,
    Server,
    ServerResponse,
    STATUS_CODES,
    METHODS,
    [ACTIVE_SERVERS]: activeServers,
  };

  return mod;
}

/** Standard reason phrases — required by ws's handshake abort path, among others. */
export const STATUS_CODES: Record<number, string> = {
  100: 'Continue', 101: 'Switching Protocols', 102: 'Processing', 103: 'Early Hints',
  200: 'OK', 201: 'Created', 202: 'Accepted', 203: 'Non-Authoritative Information',
  204: 'No Content', 205: 'Reset Content', 206: 'Partial Content',
  300: 'Multiple Choices', 301: 'Moved Permanently', 302: 'Found', 303: 'See Other',
  304: 'Not Modified', 307: 'Temporary Redirect', 308: 'Permanent Redirect',
  400: 'Bad Request', 401: 'Unauthorized', 402: 'Payment Required', 403: 'Forbidden',
  404: 'Not Found', 405: 'Method Not Allowed', 406: 'Not Acceptable',
  407: 'Proxy Authentication Required', 408: 'Request Timeout', 409: 'Conflict',
  410: 'Gone', 411: 'Length Required', 412: 'Precondition Failed', 413: 'Payload Too Large',
  414: 'URI Too Long', 415: 'Unsupported Media Type', 416: 'Range Not Satisfiable',
  417: 'Expectation Failed', 426: 'Upgrade Required', 428: 'Precondition Required',
  429: 'Too Many Requests', 431: 'Request Header Fields Too Large',
  500: 'Internal Server Error', 501: 'Not Implemented', 502: 'Bad Gateway',
  503: 'Service Unavailable', 504: 'Gateway Timeout', 505: 'HTTP Version Not Supported',
};

export const METHODS = ['DELETE', 'GET', 'HEAD', 'OPTIONS', 'PATCH', 'POST', 'PUT'];

// --- Legacy static exports (for backward compatibility) ---

export function request(urlOrOptions: string | RequestOptions, optionsOrCb?: RequestOptions | ((res: IncomingMessage) => void), cb?: (res: IncomingMessage) => void): ClientRequest {
  return createHttp().request(urlOrOptions, optionsOrCb, cb);
}

export function get(urlOrOptions: string | RequestOptions, optionsOrCb?: RequestOptions | ((res: IncomingMessage) => void), cb?: (res: IncomingMessage) => void): ClientRequest {
  return createHttp().get(urlOrOptions, optionsOrCb, cb);
}

export function createServer(): never {
  throw new Error('http.createServer() is not supported in Lifo');
}

export default { request, get, createServer, IncomingMessage, ClientRequest };
