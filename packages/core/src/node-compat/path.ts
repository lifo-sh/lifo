import {
  normalize,
  isAbsolute,
  join,
  resolve,
  dirname,
  basename,
  extname,
} from '../utils/path.js';

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
  normalize, isAbsolute, join, resolve: (...args: string[]) => resolve('/', ...args),
  dirname, basename, extname, relative, parse, format, sep, delimiter,
};
// Minimal win32 path — Lifo is posix-only but packages like vite reference win32.sep
export const win32 = {
  normalize, isAbsolute, join, resolve: (...args: string[]) => resolve('/', ...args),
  dirname, basename, extname, relative, parse, format,
  sep: '\\',
  delimiter: ';',
};

export { normalize, isAbsolute, join, resolve, dirname, basename, extname };
export default {
  normalize, isAbsolute, join, resolve: (...args: string[]) => resolve('/', ...args),
  dirname, basename, extname, relative, parse, format, sep, delimiter, posix, win32,
};
