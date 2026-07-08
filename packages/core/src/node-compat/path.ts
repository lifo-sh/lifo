import {
  normalize,
  isAbsolute,
  join,
  resolve,
  dirname as _dirname,
  basename as _basename,
  extname as _extname,
} from '../utils/path.js';

// Node's path.resolve() bases relative paths on process.cwd(); mirror that so a
// tool doing path.resolve('my-app') gets <cwd>/my-app, not /my-app. During a
// node run globalThis.process is the run's process (cwd = the run's cwd);
// elsewhere it falls back to '/'.
function cwdBase(): string {
  const p = (globalThis as { process?: { cwd?: () => string } }).process;
  try { return p?.cwd?.() || '/'; } catch { return '/'; }
}

// Some npm packages (import-fresh via cosmiconfig, caller-path) derive a path
// from a call-stack frame's getFileName(), which is undefined for our eval-based
// module execution. They then call path.dirname(undefined). Node would throw a
// TypeError, but here the argument is undefined only because of an environment
// limitation, and callers like import-fresh pass an absolute path onward (so the
// derived directory is unused). Coerce non-string input instead of crashing.
export function dirname(path: string): string {
  return typeof path === 'string' ? _dirname(path) : '.';
}
export function basename(path: string, ext?: string): string {
  return typeof path === 'string' ? _basename(path, ext) : '';
}
export function extname(path: string): string {
  return typeof path === 'string' ? _extname(path) : '';
}

export function relative(from: string, to: string): string {
  const fromParts = normalize(from).split('/').filter(Boolean);
  const toParts = normalize(to).split('/').filter(Boolean);

  let common = 0;
  while (
    common < fromParts.length &&
    common < toParts.length &&
    fromParts[common] === toParts[common]
  ) {
    common++;
  }

  const ups = fromParts.length - common;
  const rest = toParts.slice(common);
  const parts = [...Array(ups).fill('..'), ...rest];
  return parts.join('/') || '.';
}

export interface ParsedPath {
  root: string;
  dir: string;
  base: string;
  ext: string;
  name: string;
}

export function parse(path: string): ParsedPath {
  const root = isAbsolute(path) ? '/' : '';
  const dir = dirname(path);
  const base = basename(path);
  const ext = extname(path);
  const name = ext ? base.slice(0, -ext.length) : base;
  return { root, dir, base, ext, name };
}

export function format(pathObj: Partial<ParsedPath>): string {
  const dir = pathObj.dir || pathObj.root || '';
  const base = pathObj.base || ((pathObj.name || '') + (pathObj.ext || ''));
  if (dir) {
    return dir.endsWith('/') ? dir + base : dir + '/' + base;
  }
  return base;
}

export const sep = '/';
export const delimiter = ':';
export const posix = {
  normalize, isAbsolute, join, resolve: (...args: string[]) => resolve(cwdBase(), ...args),
  dirname, basename, extname, relative, parse, format, sep, delimiter,
};
// Minimal win32 path — Lifo is posix-only but packages like vite reference win32.sep
export const win32 = {
  normalize, isAbsolute, join, resolve: (...args: string[]) => resolve(cwdBase(), ...args),
  dirname, basename, extname, relative, parse, format,
  sep: '\\',
  delimiter: ';',
};

export { normalize, isAbsolute, join, resolve };
export default {
  normalize, isAbsolute, join, resolve: (...args: string[]) => resolve(cwdBase(), ...args),
  dirname, basename, extname, relative, parse, format, sep, delimiter, posix, win32,
};
