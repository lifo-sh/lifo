const mimeTypes = new Map<string, string>([
  // Text
  ['.txt', 'text/plain'],
  ['.md', 'text/markdown'],
  ['.json', 'application/json'],
  ['.js', 'text/javascript'],
  ['.ts', 'text/typescript'],
  ['.jsx', 'text/jsx'],
  ['.tsx', 'text/tsx'],
  ['.css', 'text/css'],
  ['.html', 'text/html'],
  ['.xml', 'text/xml'],
  ['.yaml', 'text/yaml'],
  ['.yml', 'text/yaml'],
  ['.toml', 'text/toml'],
  ['.ini', 'text/plain'],
  ['.cfg', 'text/plain'],
  ['.conf', 'text/plain'],
  ['.sh', 'text/x-shellscript'],
  ['.bash', 'text/x-shellscript'],
  ['.zsh', 'text/x-shellscript'],
  ['.py', 'text/x-python'],
  ['.rb', 'text/x-ruby'],
  ['.go', 'text/x-go'],
  ['.rs', 'text/x-rust'],
  ['.c', 'text/x-c'],
  ['.cpp', 'text/x-c++'],
  ['.h', 'text/x-c'],
  ['.hpp', 'text/x-c++'],
  ['.java', 'text/x-java'],
  ['.csv', 'text/csv'],
  ['.log', 'text/plain'],
  ['.env', 'text/plain'],
  ['.gitignore', 'text/plain'],
  ['.dockerignore', 'text/plain'],
  ['.sql', 'text/x-sql'],
  ['.graphql', 'text/x-graphql'],
  ['.vue', 'text/x-vue'],
  ['.svelte', 'text/x-svelte'],

  // Images
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.gif', 'image/gif'],
  ['.svg', 'image/svg+xml'],
  ['.webp', 'image/webp'],
  ['.ico', 'image/x-icon'],
  ['.bmp', 'image/bmp'],
  ['.tiff', 'image/tiff'],

  // Video
  ['.mp4', 'video/mp4'],
  ['.webm', 'video/webm'],
  ['.avi', 'video/x-msvideo'],
  ['.mov', 'video/quicktime'],
  ['.mkv', 'video/x-matroska'],

  // Audio
  ['.mp3', 'audio/mpeg'],
  ['.wav', 'audio/wav'],
  ['.ogg', 'audio/ogg'],
  ['.flac', 'audio/flac'],
  ['.aac', 'audio/aac'],
  ['.m4a', 'audio/mp4'],

  // Archives
  ['.zip', 'application/zip'],
  ['.tar', 'application/x-tar'],
  ['.gz', 'application/gzip'],
  ['.tgz', 'application/gzip'],
  ['.bz2', 'application/x-bzip2'],
  ['.7z', 'application/x-7z-compressed'],
  ['.rar', 'application/vnd.rar'],

  // Binary / Application
  ['.pdf', 'application/pdf'],
  ['.wasm', 'application/wasm'],
  ['.exe', 'application/x-msdownload'],
  ['.dll', 'application/x-msdownload'],
  ['.so', 'application/x-sharedlib'],
  ['.dylib', 'application/x-sharedlib'],
]);

export function getMimeType(filename: string): string {
  const dot = filename.lastIndexOf('.');
  if (dot === -1) return 'application/octet-stream';
  const ext = filename.slice(dot).toLowerCase();
  return mimeTypes.get(ext) ?? 'application/octet-stream';
}

export function getFileCategory(
  mime: string,
): 'text' | 'image' | 'video' | 'audio' | 'archive' | 'binary' {
  if (mime.startsWith('text/') || mime === 'application/json') return 'text';
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  if (
    mime === 'application/zip' ||
    mime === 'application/x-tar' ||
    mime === 'application/gzip' ||
    mime === 'application/x-bzip2' ||
    mime === 'application/x-7z-compressed' ||
    mime === 'application/vnd.rar'
  ) {
    return 'archive';
  }
  return 'binary';
}

export function isBinaryMime(mime: string): boolean {
  return getFileCategory(mime) !== 'text';
}

/**
 * Whether a text command (grep, sed, awk, sort, …) should skip a file as binary. A known extension
 * decides as before. A missing or unknown one (Makefile, Dockerfile, LICENSE, .mjs, .lock, …) used
 * to fall back to application/octet-stream and was skipped as "binary file" without being read; now
 * the first bytes decide, as GNU grep does: a NUL byte means binary.
 */
export function isBinaryFile(vfs: { readFile(path: string): Uint8Array }, path: string): boolean {
  const mime = getMimeType(path);
  if (mime !== 'application/octet-stream') return isBinaryMime(mime);
  try {
    const bytes = vfs.readFile(path);
    const n = Math.min(bytes.length, 8000);
    for (let i = 0; i < n; i++) if (bytes[i] === 0) return true;
    return false;
  } catch {
    return false; // let the command's own read report the error
  }
}
