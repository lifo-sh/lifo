// The server half of the `browser` command: fetch one public web page for a box, safely.
//
// A box runs in a visitor's tab and can't read other sites (CORS), so the text browser asks
// the page's own server for them: GET /api/browse?url=<url> → { url, status, contentType, body }.
// That makes the server a fetcher on the visitor's behalf, so it is deliberately narrow:
//
//   - GET only, http and https only, ports 80, 443, 8080 and 8443, no user:pass@ in the URL;
//   - every address a host name resolves to must be public (address.ts); the check runs inside
//     the connection's own DNS lookup, so a name can't pass the check and then connect elsewhere
//     (DNS rebinding), and IP literals are checked before connecting;
//   - redirects are followed by hand, at most 5, and each hop is checked again;
//   - 10 s for the whole thing, bodies cut at 2 MB (after decompression);
//   - HTML, XHTML, plain text and JSON only;
//   - no cookies or credentials either way, a generic User-Agent;
//   - a per-client rate limit (in memory: per server instance, best effort).
//
// `handleBrowseRequest` takes and returns standard Request/Response objects so a Next.js route
// and a Vite dev-server middleware can both serve it.

import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import zlib from 'node:zlib';
import type { Readable } from 'node:stream';
import { isPublicAddress } from './address.js';

export { isPublicAddress } from './address.js';

export interface BrowseResult {
  /** The final URL, after redirects. */
  url: string;
  status: number;
  contentType: string;
  body: string;
  /** True when the body was cut at the size limit. */
  truncated?: boolean;
}

export class BrowseError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface BrowseOptions {
  /** Default 10 000 ms. */
  timeoutMs?: number;
  /** Default 2 MB. */
  maxBytes?: number;
  /** Default 5. */
  maxRedirects?: number;
  /** Default [80, 443, 8080, 8443]. */
  allowedPorts?: number[];
  /** Default: isPublicAddress. Tests swap it to reach a local server. */
  isAllowedAddress?: (ip: string) => boolean;
  userAgent?: string;
}

const ALLOWED_TYPES = /^(text\/html|application\/xhtml\+xml|text\/plain|application\/json|application\/[a-z0-9.+-]*\+json)$/;
const DEFAULT_UA = 'Mozilla/5.0 (compatible; LifoBrowser/0.1; +https://lifo.sh/docs/build/agents)';

function checkUrl(raw: string, opts: Required<Pick<BrowseOptions, 'allowedPorts' | 'isAllowedAddress'>>): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new BrowseError(400, `not a URL: ${raw}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new BrowseError(400, `only http and https URLs can be opened (got ${url.protocol})`);
  if (url.username || url.password) throw new BrowseError(400, 'URLs with a user name or password are not allowed');
  const port = url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80;
  if (!opts.allowedPorts.includes(port)) throw new BrowseError(400, `port ${port} is not allowed (only ${opts.allowedPorts.join(', ')})`);
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host) && !opts.isAllowedAddress(host)) throw new BrowseError(403, `refusing ${host}: not a public address`);
  if (!host || host === 'localhost' || host.endsWith('.localhost')) throw new BrowseError(403, `refusing ${host || 'an empty host'}: not a public address`);
  return url;
}

type LookupCallback = (err: NodeJS.ErrnoException | null, address?: string | dns.LookupAddress[], family?: number) => void;

function guardedLookup(isAllowed: (ip: string) => boolean) {
  return (hostname: string, options: dns.LookupOptions, callback: LookupCallback) => {
    dns.lookup(hostname, { all: true, verbatim: true }, (err, addresses) => {
      if (err) return callback(err);
      const bad = addresses.find((a) => !isAllowed(a.address));
      if (bad || addresses.length === 0) {
        const e: NodeJS.ErrnoException = new Error(`refusing ${hostname}: it resolves to ${bad ? bad.address : 'nothing'}, not a public address`);
        e.code = 'EBLOCKED';
        return callback(e);
      }
      const wanted = options.family === 4 || options.family === 6 ? addresses.filter((a) => a.family === options.family) : addresses;
      const list = wanted.length ? wanted : addresses;
      if (options.all) callback(null, list);
      else callback(null, list[0].address, list[0].family);
    });
  };
}

interface Hop {
  status: number;
  location?: string;
  contentType: string;
  body?: string;
  truncated?: boolean;
}

function decoderFor(contentType: string): TextDecoder {
  const charset = /charset=["']?([\w-]+)/i.exec(contentType)?.[1];
  try {
    return new TextDecoder(charset || 'utf-8');
  } catch {
    return new TextDecoder('utf-8');
  }
}

function requestOnce(url: URL, o: Required<BrowseOptions>, signal: AbortSignal): Promise<Hop> {
  return new Promise((resolve, reject) => {
    const mod = url.protocol === 'https:' ? https : http;
    const req = mod.request(
      url,
      {
        method: 'GET',
        agent: false,
        signal,
        lookup: guardedLookup(o.isAllowedAddress) as unknown as typeof dns.lookup,
        headers: {
          'user-agent': o.userAgent,
          accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,application/json;q=0.8',
          'accept-language': 'en',
          'accept-encoding': 'gzip, deflate, br',
        },
      },
      (res) => {
        const status = res.statusCode ?? 0;
        const contentType = String(res.headers['content-type'] ?? '');
        if (status >= 300 && status < 400 && res.headers.location) {
          res.resume();
          resolve({ status, location: String(res.headers.location), contentType });
          return;
        }
        const mime = contentType.split(';')[0].trim().toLowerCase();
        if (mime && !ALLOWED_TYPES.test(mime)) {
          res.destroy();
          reject(new BrowseError(415, `the page is ${mime}; only HTML, plain text and JSON can be opened`));
          return;
        }
        const enc = String(res.headers['content-encoding'] ?? '').toLowerCase();
        let stream: Readable = res;
        if (enc === 'gzip' || enc === 'x-gzip') stream = res.pipe(zlib.createGunzip());
        else if (enc === 'deflate') stream = res.pipe(zlib.createInflate());
        else if (enc === 'br') stream = res.pipe(zlib.createBrotliDecompress());
        const chunks: Buffer[] = [];
        let size = 0;
        let truncated = false;
        const done = () => {
          const buf = Buffer.concat(chunks);
          resolve({ status, contentType: contentType || 'text/plain', body: decoderFor(contentType).decode(buf), truncated });
        };
        stream.on('data', (chunk: Buffer) => {
          if (truncated) return;
          const room = o.maxBytes - size;
          if (chunk.length >= room) {
            chunks.push(chunk.subarray(0, room));
            size = o.maxBytes;
            truncated = true;
            res.destroy();
            done();
            return;
          }
          chunks.push(chunk);
          size += chunk.length;
        });
        stream.on('end', () => !truncated && done());
        stream.on('error', (e) => !truncated && reject(e));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

/** Fetches `target` under the rules above. Throws BrowseError with an HTTP status for the caller. */
export async function browse(target: string, options: BrowseOptions = {}): Promise<BrowseResult> {
  const o: Required<BrowseOptions> = {
    timeoutMs: options.timeoutMs ?? 10_000,
    maxBytes: options.maxBytes ?? 2 * 1024 * 1024,
    maxRedirects: options.maxRedirects ?? 5,
    allowedPorts: options.allowedPorts ?? [80, 443, 8080, 8443],
    isAllowedAddress: options.isAllowedAddress ?? isPublicAddress,
    userAgent: options.userAgent ?? DEFAULT_UA,
  };
  const signal = AbortSignal.timeout(o.timeoutMs);
  let url = checkUrl(target, o);
  for (let hop = 0; ; hop++) {
    let r: Hop;
    try {
      r = await requestOnce(url, o, signal);
    } catch (e) {
      if (e instanceof BrowseError) throw e;
      const err = e as NodeJS.ErrnoException;
      if (err.code === 'EBLOCKED') throw new BrowseError(403, err.message);
      if (signal.aborted || err.name === 'AbortError') throw new BrowseError(504, `timed out after ${o.timeoutMs / 1000} s`);
      if (err.code === 'ENOTFOUND') throw new BrowseError(502, `can't find the server ${url.hostname}`);
      throw new BrowseError(502, `couldn't load ${url.href}: ${err.message}`);
    }
    if (r.location !== undefined) {
      if (hop >= o.maxRedirects) throw new BrowseError(508, `more than ${o.maxRedirects} redirects`);
      url = checkUrl(new URL(r.location, url).href, o);
      continue;
    }
    return { url: url.href, status: r.status, contentType: r.contentType, body: r.body ?? '', ...(r.truncated && { truncated: true }) };
  }
}

/** A fixed-window counter per key. In memory, so per server instance. */
export function createRateLimiter({ limit = 30, windowMs = 60_000 } = {}) {
  const hits = new Map<string, { count: number; reset: number }>();
  return (key: string): boolean => {
    const now = Date.now();
    if (hits.size > 10_000) for (const [k, v] of hits) if (v.reset <= now) hits.delete(k);
    const h = hits.get(key);
    if (!h || h.reset <= now) {
      hits.set(key, { count: 1, reset: now + windowMs });
      return true;
    }
    h.count++;
    return h.count <= limit;
  };
}

const defaultLimiter = createRateLimiter();

export interface HandlerOptions extends BrowseOptions {
  /** Who is asking, for the rate limit (an IP address). */
  clientKey?: string;
  limiter?: (key: string) => boolean;
}

/** GET ?url=<url> → JSON BrowseResult, or { error } with a 4xx/5xx status. */
export async function handleBrowseRequest(req: Request, options: HandlerOptions = {}): Promise<Response> {
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
  if (req.method !== 'GET') return json(405, { error: 'only GET is supported' });
  // Pages on other sites may not use this endpoint from their visitors' browsers.
  const site = req.headers.get('sec-fetch-site');
  if (site && site !== 'same-origin' && site !== 'none') return json(403, { error: 'cross-site requests are not allowed' });
  const limiter = options.limiter ?? defaultLimiter;
  if (!limiter(options.clientKey ?? 'anonymous')) return json(429, { error: 'too many pages; wait a minute' });
  const target = new URL(req.url).searchParams.get('url');
  if (!target) return json(400, { error: 'missing ?url=' });
  try {
    return json(200, await browse(target, options));
  } catch (e) {
    if (e instanceof BrowseError) return json(e.status, { error: e.message });
    return json(500, { error: (e as Error).message });
  }
}
