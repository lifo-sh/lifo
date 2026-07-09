// Re-export native URL and URLSearchParams
const _URL = globalThis.URL;
const _URLSearchParams = globalThis.URLSearchParams;

export { _URL as URL, _URLSearchParams as URLSearchParams };

export function parse(
  urlString: string,
  parseQueryString = false,
): {
  protocol: string | null;
  hostname: string | null;
  port: string | null;
  pathname: string;
  search: string | null;
  hash: string | null;
  host: string | null;
  href: string;
  path: string;
  query: string | Record<string, string> | null;
} {
  // Server req.url values are relative ("/a/b?c=1"); `new URL` throws on those,
  // so parse against a dummy base and null out the origin fields (matching
  // Node's url.parse). Getting this right is essential: Metro detects bundles
  // via `pathname.endsWith('.bundle')`, which breaks if the query leaks into
  // pathname. `parseQueryString` returns `query` as an object (Node semantics).
  let u: URL;
  let isRelative = false;
  try {
    u = new URL(urlString);
  } catch {
    try {
      u = new URL(urlString, 'http://lifo.local');
      isRelative = true;
    } catch {
      return {
        protocol: null, hostname: null, port: null,
        pathname: urlString, search: null, hash: null, host: null,
        href: urlString, path: urlString,
        query: parseQueryString ? {} : null,
      };
    }
  }

  const query: string | Record<string, string> | null = parseQueryString
    ? Object.fromEntries(u.searchParams.entries())
    : u.search ? u.search.slice(1) : null;

  return {
    protocol: isRelative ? null : u.protocol,
    hostname: isRelative ? null : u.hostname,
    port: isRelative ? null : (u.port || null),
    pathname: u.pathname,
    search: u.search || null,
    hash: u.hash || null,
    host: isRelative ? null : u.host,
    href: isRelative ? u.pathname + u.search + u.hash : u.href,
    path: u.pathname + (u.search || ''),
    query,
  };
}

export function format(urlObj: {
  protocol?: string | null;
  slashes?: boolean;
  hostname?: string | null;
  host?: string | null;
  port?: string | number | null;
  pathname?: string | null;
  search?: string | null;
  query?: string | Record<string, string> | null;
  hash?: string | null;
}): string {
  let result = '';
  if (urlObj.protocol) {
    // Node stores protocol with a trailing ':', but callers (e.g. Metro's
    // `url.format({...urlObj, protocol: "http"})`) may omit it. Without the
    // colon, `protocol + "//"` yields "http//" and the whole URL is malformed.
    result += urlObj.protocol.endsWith(':') ? urlObj.protocol : urlObj.protocol + ':';
  }
  // Prefer `host` (host:port together) — Metro sets this; fall back to hostname[:port].
  const host = urlObj.host
    ? urlObj.host
    : urlObj.hostname
      ? urlObj.hostname + (urlObj.port != null && urlObj.port !== '' ? ':' + urlObj.port : '')
      : '';
  const wantsSlashes =
    urlObj.slashes === true ||
    !!host ||
    (!!urlObj.protocol && /^(?:https?|ftp|gopher|file|wss?):?$/i.test(urlObj.protocol));
  if (wantsSlashes) result += '//';
  if (host) result += host;
  if (urlObj.pathname) {
    // Node prepends '/' to a pathname that doesn't start with one when the URL
    // has an authority — otherwise host and path fuse (e.g. Metro HMR building
    // "http://host" + "App.bundle" → "http://hostApp.bundle", an empty-path URL).
    result += wantsSlashes && !urlObj.pathname.startsWith('/') ? '/' + urlObj.pathname : urlObj.pathname;
  }
  if (urlObj.search) {
    result += urlObj.search.startsWith('?') ? urlObj.search : '?' + urlObj.search;
  } else if (urlObj.query && typeof urlObj.query === 'object') {
    const qs = new _URLSearchParams(urlObj.query as Record<string, string>).toString();
    if (qs) result += '?' + qs;
  }
  if (urlObj.hash) {
    result += urlObj.hash.startsWith('#') ? urlObj.hash : '#' + urlObj.hash;
  }
  return result;
}

export function resolve(from: string, to: string): string {
  return new URL(to, from).href;
}

export function fileURLToPath(url: string | URL): string {
  const urlStr = typeof url === 'string' ? url : url.href;
  if (!urlStr.startsWith('file://')) {
    throw new TypeError('The URL must be of scheme file');
  }
  // Remove file:// prefix and decode percent-encoded characters
  return decodeURIComponent(urlStr.slice(7));
}

export function pathToFileURL(path: string): URL {
  return new URL('file://' + encodeURI(path));
}

/**
 * Convert a WHATWG URL into the options object `http.request`/`https.request`
 * accept (Node's `url.urlToHttpOptions`). Our `curl` and other http callers
 * feed a `new URL(...)` through this before dispatching.
 */
export function urlToHttpOptions(url: URL): {
  protocol?: string; hostname?: string; hash?: string; search?: string;
  pathname?: string; path?: string; href?: string; port?: string | number; auth?: string;
} {
  const options: ReturnType<typeof urlToHttpOptions> = {
    protocol: url.protocol,
    hostname: typeof url.hostname === 'string' && url.hostname.startsWith('[')
      ? url.hostname.slice(1, -1)
      : url.hostname,
    hash: url.hash,
    search: url.search,
    pathname: url.pathname,
    path: `${url.pathname || ''}${url.search || ''}`,
    href: url.href,
  };
  if (url.port !== '') options.port = Number(url.port);
  if (url.username || url.password) {
    options.auth = `${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`;
  }
  return options;
}

export default { URL, URLSearchParams, parse, format, resolve, fileURLToPath, pathToFileURL, urlToHttpOptions };
