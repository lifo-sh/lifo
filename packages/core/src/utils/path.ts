/**
 * POSIX path operations -- pure string manipulation, no I/O.
 */

export function normalize(path: string): string {
  if (path === '') return '.';

  const absolute = path.startsWith('/');
  const parts = path.split('/');
  const resolved: string[] = [];

  for (const part of parts) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (resolved.length > 0 && resolved[resolved.length - 1] !== '..') {
        resolved.pop();
      } else if (!absolute) {
        resolved.push('..');
      }
    } else {
      resolved.push(part);
    }
  }

  let result = resolved.join('/');
  if (absolute) result = '/' + result;
  return result || (absolute ? '/' : '.');
}

export function isAbsolute(path: string): boolean {
  return path.startsWith('/');
}

export function join(...segments: string[]): string {
  return normalize(segments.filter(Boolean).join('/'));
}

export function resolve(cwd: string, ...segments: string[]): string {
  let result = cwd;
  for (const seg of segments) {
    if (isAbsolute(seg)) {
      result = seg;
    } else {
      result = result + '/' + seg;
    }
  }
  return normalize(result);
}

export function dirname(path: string): string {
  // Matches Node's path.posix.dirname: strips the last path segment WITHOUT
  // normalizing. Normalizing first is wrong — dirname('/a/b/.') is '/a/b' in
  // Node (Metro passes origin paths like '/project/.'), but normalize-then-slice
  // would collapse '/.' and yield '/a'.
  if (path.length === 0) return '.';
  const hasRoot = path.charCodeAt(0) === 47; // '/'
  let end = -1;
  let matchedSlash = true;
  for (let i = path.length - 1; i >= 1; --i) {
    if (path.charCodeAt(i) === 47) {
      if (!matchedSlash) { end = i; break; }
    } else {
      matchedSlash = false;
    }
  }
  if (end === -1) return hasRoot ? '/' : '.';
  if (hasRoot && end === 1) return '//';
  return path.slice(0, end);
}

export function basename(path: string, ext?: string): string {
  const normalized = normalize(path);
  const lastSlash = normalized.lastIndexOf('/');
  let base = lastSlash === -1 ? normalized : normalized.slice(lastSlash + 1);
  if (ext && base.endsWith(ext)) {
    base = base.slice(0, -ext.length);
  }
  return base;
}

export function extname(path: string): string {
  const base = basename(path);
  const dotIndex = base.lastIndexOf('.');
  if (dotIndex <= 0) return '';
  return base.slice(dotIndex);
}

export function split(path: string): string[] {
  const normalized = normalize(path);
  if (normalized === '/') return ['/'];
  const parts = normalized.split('/').filter(Boolean);
  if (normalized.startsWith('/')) {
    return ['/', ...parts];
  }
  return parts;
}
