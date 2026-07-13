import { EventEmitter } from './events.js';
import { Buffer } from './buffer.js';
import type { VirtualRequestHandler, VirtualResponse } from '../kernel/index.js';
import { makeProxyingFetch } from './proxy-fetch.js';

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

/**
 * A socket stub that is a real EventEmitter. Middleware like `on-finished` /
 * `ee-first` (used by Express's `send`/`express.static`) attaches 'error' /
 * 'close' / 'end' listeners to `req.socket` / `res.socket`; a plain object
 * without `.on` crashes with "ee.on is not a function".
 */
type SocketStub = EventEmitter & {
  remoteAddress?: string;
  remotePort?: number;
  encrypted?: boolean;
  writable?: boolean;
  readable?: boolean;
  destroy: () => void;
  unref?: () => void;
  ref?: () => void;
};

function createSocketStub(props: Partial<SocketStub>): SocketStub {
  return Object.assign(new EventEmitter(), { destroy: () => {}, ...props }) as SocketStub;
}

class IncomingMessage extends EventEmitter {
  statusCode: number;
  statusMessage: string;
  headers: Record<string, string>;
  /** Node's flat [name, value, name, value, ...] view of the headers.
   *  expo-server's convertRequest iterates it (crashes on undefined). */
  rawHeaders: string[];
  method?: string;
  url?: string;
  httpVersion = '1.1';
  httpVersionMajor = 1;
  httpVersionMinor = 1;
  complete = false;
  aborted = false;
  destroyed = false;
  readable = true;
  // Socket stub (an EventEmitter) that Vite/Connect/Express middleware expects.
  socket: SocketStub;
  connection: SocketStub;

  constructor(statusCode: number, statusMessage: string, headers: Record<string, string>) {
    super();
    this.statusCode = statusCode;
    this.statusMessage = statusMessage;
    this.headers = headers;
    this.rawHeaders = Object.entries(headers).flatMap(([k, v]) => [k, v]);
    const socketStub = createSocketStub({
      remoteAddress: '127.0.0.1',
      remotePort: 0,
      encrypted: false,
      unref: () => {},
      ref: () => {},
    });
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
    this.destroyed = true;
    return this;
  }

  /** Socket-idle-timeout stub — fetch-nodeshim calls res.setTimeout(0). */
  setTimeout(_ms: number, _cb?: () => void): this {
    return this;
  }
}

class ClientRequest extends EventEmitter {
  private options: RequestOptions;
  private body = '';
  private aborted = false;
  private portRegistry?: Map<number, VirtualRequestHandler>;
  private protocol: 'http:' | 'https:';
  private fetchImpl?: typeof fetch;

  constructor(options: RequestOptions, cb?: (res: IncomingMessage) => void, portRegistry?: Map<number, VirtualRequestHandler>, protocol: 'http:' | 'https:' = 'http:', fetchImpl?: typeof fetch) {
    super();
    this.options = options;
    this.portRegistry = portRegistry;
    this.protocol = protocol;
    this.fetchImpl = fetchImpl;
    if (cb) this.on('response', cb as (...args: unknown[]) => void);

    // Defer the actual fetch
    queueMicrotask(() => this.execute());
  }

  write(data: string | Uint8Array): boolean {
    this._chunks.push(data);
    return true;
  }

  end(data?: string | Uint8Array): void {
    if (data != null) this._chunks.push(data);
    this.emit('finish');
  }

  private _chunks: Array<string | Uint8Array> = [];

  /** Assemble the request body binary-safely (fetch-nodeshim pipes
   *  Uint8Array chunks; string-concatenating them would corrupt binaries). */
  private buildBody(): string | Uint8Array | undefined {
    if (this._chunks.length === 0) return this.body || undefined;
    if (this._chunks.every((c) => typeof c === 'string')) {
      return this.body + (this._chunks as string[]).join('');
    }
    const enc = new TextEncoder();
    const parts: Uint8Array[] = [];
    if (this.body) parts.push(enc.encode(this.body));
    for (const c of this._chunks) parts.push(typeof c === 'string' ? enc.encode(c) : c);
    let total = 0;
    for (const p of parts) total += p.length;
    const out = new Uint8Array(total);
    let off = 0;
    for (const p of parts) { out.set(p, off); off += p.length; }
    return out;
  }

  // Node request-header API. fetch-nodeshim (minifetch) sets its headers via
  // req.setHeader/hasHeader AFTER https.request() returns — without these it
  // threw "e.setHeader is not a function" and every @expo/cli API call died.
  setHeader(name: string, value: string | string[] | number): this {
    if (!this.options.headers) this.options.headers = {};
    (this.options.headers as Record<string, string>)[name] = Array.isArray(value) ? value.join(', ') : String(value);
    return this;
  }

  getHeader(name: string): string | undefined {
    const h = (this.options.headers ?? {}) as Record<string, string>;
    const k = Object.keys(h).find((k) => k.toLowerCase() === name.toLowerCase());
    return k !== undefined ? h[k] : undefined;
  }

  hasHeader(name: string): boolean {
    return this.getHeader(name) !== undefined;
  }

  removeHeader(name: string): void {
    const h = this.options.headers as Record<string, string> | undefined;
    if (!h) return;
    for (const k of Object.keys(h)) {
      if (k.toLowerCase() === name.toLowerCase()) delete h[k];
    }
  }

  flushHeaders(): void {}

  abort(): void {
    this.aborted = true;
  }

  /** Node req.destroy(err) — abort the in-flight request. fetch-nodeshim's
   *  error/abort path calls it unconditionally. */
  destroyed = false;
  destroy(_err?: unknown): this {
    this.aborted = true;
    this.destroyed = true;
    return this;
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
        const built = this.buildBody();
        const vReq = {
          method: this.options.method || 'GET',
          url: path,
          headers: this.options.headers || {},
          body: typeof built === 'string' ? built : built ? new TextDecoder().decode(built) : '',
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
      // Use the CORS-proxying fetch when provided (routes api.expo.dev etc.
      // through the relay in the browser); otherwise the plain global fetch.
      const doFetch = this.fetchImpl ?? fetch;
      const method = this.options.method || 'GET';
      const outBody = this.buildBody();
      const resp = await doFetch(url, {
        method,
        headers: this.options.headers,
        body: method !== 'GET' && method !== 'HEAD' && outBody ? (outBody as BodyInit) : undefined,
      });

      const headers: Record<string, string> = {};
      resp.headers.forEach((v, k) => { headers[k] = v; });
      // Browser fetch already decompressed the body but keeps the original
      // content-encoding/length headers — consumers (fetch-nodeshim) would
      // try to gunzip AGAIN through zlib streams. Drop them.
      delete headers['content-encoding'];
      delete headers['content-length'];

      const msg = new IncomingMessage(resp.status, resp.statusText, headers);
      this.emit('response', msg);

      // Deliver bytes (Buffer), not text — binary downloads (tarballs, wasm)
      // are corrupted by a UTF-8 round-trip.
      const buf = Buffer.from(new Uint8Array(await resp.arrayBuffer()));
      msg.emit('data', buf);
      msg.emit('end');
    } catch (e) {
      // Defer on a MACROTASK (like Node's async error delivery). Emitting
      // synchronously let callers that retry-on-error chain the next attempt
      // in the same microtask turn — a failing endpoint then spun the
      // browser's main thread forever (frozen tab on `expo start`).
      setTimeout(() => this.emit('error', e), 0);
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
  destroyed = false;
  writableEnded = false;
  writableFinished = false;
  private _headers: Record<string, string | string[]> = {};
  // Accumulate raw byte chunks so binary responses (wasm, images, fonts) are
  // preserved. A string _body would corrupt them via UTF-8 round-tripping.
  private _chunks: Uint8Array[] = [];
  private _vRes: { statusCode: number; headers: Record<string, string>; body: string; bodyBytes?: Uint8Array };
  // Socket stub (an EventEmitter) that middleware may reference / attach to
  // (e.g. on-finished in express.static).
  socket: SocketStub | null;
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
    const sock = createSocketStub({
      writable: true,
      readable: true,
      remoteAddress: '127.0.0.1',
      destroy: () => {
        sock.writable = false;
        if (!this.finished) {
          this._vRes.statusCode = this.statusCode || 500;
          this._vRes.headers = {};
          this._vRes.body = '';
          this._vRes.bodyBytes = new Uint8Array(0);
          this.finished = true;
          this._doneResolve();
        }
      },
    });
    this.socket = sock;
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

    // Register the handler in portRegistry
    const handler: VirtualRequestHandler = (vReq, vRes) => {
      // Browser requests reach us via fetch/service-worker, which strips the
      // forbidden `Host` header. Servers rely on it (Metro builds its bundle URL
      // from `req.headers.host`, and a missing host yields a malformed URL), so
      // default it to this server's own authority.
      const headers = { ...vReq.headers };
      if (!headers.host && !headers.Host) headers.host = `localhost:${port}`;
      const req = new IncomingMessage(0, '', headers);
      req.method = vReq.method;
      req.url = vReq.url;

      const res = new ServerResponse(vRes);
      // Attach the done promise to vRes so consumers (tunnel, curl) can await async middleware
      (vRes as VirtualResponseWithDone)._donePromise = res._donePromise;
      this.emit('request', req, res);

      // Emit body data + end so middleware that reads the request body works.
      // Emit a Buffer, not a string: body parsers (raw-body → body-parser →
      // express.json) run the chunk through iconv-lite, which requires a
      // Buffer/ArrayBufferView, and size checks compare byte length.
      queueMicrotask(() => {
        if (vReq.body != null && vReq.body !== '') {
          const chunk = typeof vReq.body === 'string' ? Buffer.from(vReq.body) : vReq.body;
          req.emit('data', chunk);
        }
        req.complete = true;
        req.emit('end');
      });
    };
    this.portRegistry.set(port, handler);

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
    if (this._port !== null) {
      this.portRegistry.delete(this._port);
      getUpgradeHandlers(this.portRegistry).delete(this._port);
    }

    // Remove from active servers list
    const idx = this._activeServers.indexOf(this);
    if (idx !== -1) this._activeServers.splice(idx, 1);

    if (this._closeResolve) {
      this._closeResolve();
      this._closeResolve = null;
    }

    this.emit('close');

    // Invoke the callback SYNCHRONOUSLY (before returning). Expo's wrapper does
    // `originalClose(callback); <tear down ws endpoints>` — the teardown throws
    // in the VM, so if our callback were deferred (queueMicrotask) the throw
    // would reject Expo's close promise ("Failed to stop server") before the
    // callback resolved it. Resolving first means the later throw is swallowed
    // (promise already settled).
    if (callback) {
      try { callback(); } catch { /* caller's callback threw; not our concern */ }
    }

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

// --- Agent class ---
/**
 * Minimal http(s).Agent. Real Node's Agent manages a socket pool; the VM has
 * no real sockets, but many packages SUBCLASS it and call super(options) at
 * module-load time — e.g. agent-base → https-proxy-agent → metro-cache's
 * HttpStore (pulled in by Expo SDK 54's Metro). So it must be a constructable
 * EventEmitter with the usual fields + no-op methods, even though it never
 * actually connects.
 */
class Agent extends EventEmitter {
  options: Record<string, unknown>;
  maxSockets = Infinity;
  maxFreeSockets = 256;
  maxTotalSockets = Infinity;
  sockets: Record<string, unknown[]> = {};
  freeSockets: Record<string, unknown[]> = {};
  requests: Record<string, unknown[]> = {};
  protocol = 'http:';
  constructor(options: Record<string, unknown> = {}) {
    super();
    this.options = options || {};
  }
  addRequest(): void {}
  createConnection(): never {
    throw new Error('http.Agent.createConnection() is not supported in Lifo');
  }
  getName(): string { return 'lifo:agent'; }
  destroy(): void {}
}

export function createHttp(
  portRegistry?: Map<number, VirtualRequestHandler>,
  protocol: 'http:' | 'https:' = 'http:',
  env?: Record<string, string>,
) {
  // Track active servers created by this http module instance
  const activeServers: Server[] = [];

  // Outbound requests to known non-CORS hosts (api.expo.dev etc.) must route
  // through the CORS proxy in the browser — @expo/cli reaches the network via
  // require('https').request (fetch-nodeshim), not the injected global fetch,
  // so this module needs the same proxying the node command's fetch gets.
  // Without it `expo start` froze the tab: the native-modules request to
  // api.expo.dev died on CORS and the CLI's retry path spun the main thread.
  const realFetch = (globalThis as { fetch?: typeof fetch }).fetch;
  const proxiedFetch = env && typeof realFetch === 'function'
    ? makeProxyingFetch(realFetch.bind(globalThis), env)
    : undefined;

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

    return new ClientRequest(options, callback, portRegistry, protocol, proxiedFetch);
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

  const agent = new Agent();
  agent.protocol = protocol;

  const mod = {
    request: httpRequest,
    get: httpGet,
    createServer: httpCreateServer,
    IncomingMessage,
    ClientRequest,
    Server,
    ServerResponse,
    Agent,
    globalAgent: agent,
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

export default { request, get, createServer, IncomingMessage, ClientRequest, Agent };
