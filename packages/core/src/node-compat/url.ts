// Re-export native URL and URLSearchParams
const _URL = globalThis.URL;
const _URLSearchParams = globalThis.URLSearchParams;

export { _URL as URL, _URLSearchParams as URLSearchParams };

export function parse(urlString: string): {
  protocol: string | null;
  hostname: string | null;
  port: string | null;
  pathname: string;
  search: string | null;
  hash: string | null;
  host: string | null;
  href: string;
  path: string;
  query: string | null;
} {
  try {
    const u = new URL(urlString);
    return {
      protocol: u.protocol,
      hostname: u.hostname,
      port: u.port || null,
      pathname: u.pathname,
      search: u.search || null,
      hash: u.hash || null,
      host: u.host,
      href: u.href,
      path: u.pathname + (u.search || ''),
      query: u.search ? u.search.slice(1) : null,
    };
  } catch {
    return {
      protocol: null,
      hostname: null,
      port: null,
      pathname: urlString,
      search: null,
      hash: null,
      host: null,
      href: urlString,
      path: urlString,
      query: null,
    };
  }
}

export function format(urlObj: { protocol?: string; hostname?: string; port?: string | number; pathname?: string; search?: string; hash?: string }): string {
  let result = '';
  if (urlObj.protocol) result += urlObj.protocol + '//';
  if (urlObj.hostname) result += urlObj.hostname;
  if (urlObj.port) result += ':' + urlObj.port;
  if (urlObj.pathname) result += urlObj.pathname;
  if (urlObj.search) result += urlObj.search;
  if (urlObj.hash) result += urlObj.hash;
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

export default { URL, URLSearchParams, parse, format, resolve, fileURLToPath, pathToFileURL };
