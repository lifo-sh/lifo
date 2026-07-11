import type { VFS } from '../kernel/vfs/index.js';
import { resolve, dirname } from './path.js';
import { encode, decode, concatBytes } from './encoding.js';

// ─── CRC-32 ───

const crcTable = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let c = i;
  for (let j = 0; j < 8; j++) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  crcTable[i] = c;
}

export function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    crc = crcTable[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// ─── Gzip (browser CompressionStream/DecompressionStream) ───

export async function compressGzip(data: Uint8Array): Promise<Uint8Array> {
  const cs = new CompressionStream('gzip');
  const writer = cs.writable.getWriter();
  writer.write(data as unknown as ArrayBuffer);
  writer.close();

  const reader = cs.readable.getReader();
  const chunks: Uint8Array[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  return concatBytes(...chunks);
}

export async function decompressGzip(data: Uint8Array): Promise<Uint8Array> {
  const ds = new DecompressionStream('gzip');
  const writer = ds.writable.getWriter();
  writer.write(data as unknown as ArrayBuffer);
  writer.close();

  const reader = ds.readable.getReader();
  const chunks: Uint8Array[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  return concatBytes(...chunks);
}

// ─── Tar format (POSIX ustar, 512-byte blocks) ───

export interface TarEntry {
  path: string;
  data: Uint8Array;
  type: 'file' | 'directory';
  mode: number;
  mtime: number;
}

function tarWriteString(buf: Uint8Array, offset: number, str: string, len: number): void {
  const bytes = encode(str);
  buf.set(bytes.subarray(0, len), offset);
}

function tarWriteOctal(buf: Uint8Array, offset: number, value: number, len: number): void {
  const str = value.toString(8).padStart(len - 1, '0');
  tarWriteString(buf, offset, str, len - 1);
  buf[offset + len - 1] = 0;
}

function tarChecksum(header: Uint8Array): number {
  let sum = 0;
  for (let i = 0; i < 512; i++) {
    // Checksum field (offset 148, length 8) is treated as spaces
    sum += i >= 148 && i < 156 ? 0x20 : header[i];
  }
  return sum;
}

function tarReadString(buf: Uint8Array, offset: number, len: number): string {
  let end = offset;
  const max = offset + len;
  while (end < max && buf[end] !== 0) end++;
  return decode(buf.subarray(offset, end));
}

function tarReadOctal(buf: Uint8Array, offset: number, len: number): number {
  const str = tarReadString(buf, offset, len).trim();
  return str ? parseInt(str, 8) : 0;
}

/**
 * A GNU long-name header ('L') + payload, emitted before an entry whose path
 * exceeds the 100-byte `name` field. parseTar() decodes typeflag 76 into the
 * next entry's path, so deep trees (e.g. node_modules) round-trip instead of
 * truncating and colliding.
 */
function tarLongNameBlocks(pathBytes: Uint8Array): Uint8Array[] {
  const header = new Uint8Array(512);
  tarWriteString(header, 0, '././@LongLink', 100);
  tarWriteOctal(header, 100, 0, 8); // mode
  tarWriteOctal(header, 108, 0, 8); // uid
  tarWriteOctal(header, 116, 0, 8); // gid
  tarWriteOctal(header, 124, pathBytes.length + 1, 12); // size = path + NUL
  tarWriteOctal(header, 136, 0, 12); // mtime
  header[156] = 76; // 'L'
  tarWriteString(header, 257, 'ustar', 6);
  tarWriteString(header, 263, '00', 2);
  tarWriteString(header, 265, 'user', 32);
  tarWriteString(header, 297, 'user', 32);
  tarWriteOctal(header, 148, tarChecksum(header), 7);
  header[155] = 0x20;

  const payload = new Uint8Array(Math.ceil((pathBytes.length + 1) / 512) * 512);
  payload.set(pathBytes, 0); // trailing NUL(s) already zero
  return [header, payload];
}

export function createTar(entries: TarEntry[]): Uint8Array {
  const blocks: Uint8Array[] = [];

  for (const entry of entries) {
    let path = entry.path;
    if (entry.type === 'directory' && !path.endsWith('/')) path += '/';
    // Remove leading /
    if (path.startsWith('/')) path = path.slice(1);

    const pathBytes = encode(path);
    if (pathBytes.length > 100) blocks.push(...tarLongNameBlocks(pathBytes));

    const header = new Uint8Array(512);
    tarWriteString(header, 0, path, 100);          // name (truncated if long; LongLink wins)
    tarWriteOctal(header, 100, entry.mode, 8);      // mode
    tarWriteOctal(header, 108, 0, 8);               // uid
    tarWriteOctal(header, 116, 0, 8);               // gid
    tarWriteOctal(header, 124, entry.data.length, 12); // size
    tarWriteOctal(header, 136, Math.floor(entry.mtime / 1000), 12); // mtime
    // type flag
    header[156] = entry.type === 'directory' ? 53 : 48; // '5' or '0'
    // ustar magic
    tarWriteString(header, 257, 'ustar', 6);
    tarWriteString(header, 263, '00', 2);            // version
    tarWriteString(header, 265, 'user', 32);         // uname
    tarWriteString(header, 297, 'user', 32);         // gname

    // Compute and write checksum
    const checksum = tarChecksum(header);
    tarWriteOctal(header, 148, checksum, 7);
    header[155] = 0x20; // trailing space

    blocks.push(header);

    if (entry.type === 'file' && entry.data.length > 0) {
      // Data blocks, padded to 512 bytes
      const paddedLen = Math.ceil(entry.data.length / 512) * 512;
      const dataBlock = new Uint8Array(paddedLen);
      dataBlock.set(entry.data);
      blocks.push(dataBlock);
    }
  }

  // Two zero blocks to mark end of archive
  blocks.push(new Uint8Array(1024));

  return concatBytes(...blocks);
}

/**
 * Parse a "path=..." record out of a PAX extended header payload.
 * Format: repeated "<len> key=value\n" records.
 */
function parsePaxPath(payload: Uint8Array): string | null {
  const text = new TextDecoder().decode(payload);
  let i = 0;
  while (i < text.length) {
    const space = text.indexOf(' ', i);
    if (space === -1) break;
    const len = parseInt(text.slice(i, space), 10);
    if (!Number.isFinite(len) || len <= 0) break;
    const record = text.slice(space + 1, i + len - 1); // exclude trailing \n
    const eq = record.indexOf('=');
    if (eq !== -1 && record.slice(0, eq) === 'path') return record.slice(eq + 1);
    i += len;
  }
  return null;
}

export function parseTar(data: Uint8Array): TarEntry[] {
  const entries: TarEntry[] = [];
  let offset = 0;
  // Long-name overrides for the NEXT file entry, set by PAX ('x') / GNU ('L').
  let nextPathOverride: string | null = null;

  while (offset + 512 <= data.length) {
    const header = data.subarray(offset, offset + 512);

    // Check for zero block (end of archive)
    let allZero = true;
    for (let i = 0; i < 512; i++) {
      if (header[i] !== 0) { allZero = false; break; }
    }
    if (allZero) break;

    const nameField = tarReadString(header, 0, 100);
    const mode = tarReadOctal(header, 100, 8);
    const size = tarReadOctal(header, 124, 12);
    const mtime = tarReadOctal(header, 136, 12) * 1000;
    const typeFlag = header[156];
    // ustar prefix field (bytes 345..500): full path = prefix + '/' + name.
    const prefix = tarReadString(header, 345, 155);

    offset += 512;
    const dataLen = size > 0 ? size : 0;
    const blockData = dataLen > 0 ? data.slice(offset, offset + dataLen) : new Uint8Array(0);
    if (dataLen > 0) offset += Math.ceil(dataLen / 512) * 512;

    // PAX extended header (typeFlag 'x'=120) or GNU longname ('L'=76): the
    // payload names the FOLLOWING entry. npm tarballs use these for paths
    // longer than the 100-byte name field, so without this deep-tree files
    // (e.g. @expo/cli) get dropped or misnamed.
    if (typeFlag === 120 /* x */ || typeFlag === 103 /* g (global, ignore path scope but harmless) */) {
      const p = parsePaxPath(blockData);
      if (p) nextPathOverride = p;
      continue;
    }
    if (typeFlag === 76 /* L (GNU longname) */) {
      nextPathOverride = new TextDecoder().decode(blockData).replace(/\0+$/, '');
      continue;
    }
    if (typeFlag === 75 /* K (GNU longlink) — not needed, skip payload */) {
      continue;
    }

    let path = nextPathOverride ?? (prefix ? prefix + '/' + nameField : nameField);
    nextPathOverride = null;

    const isDir = typeFlag === 53 || path.endsWith('/'); // '5' or trailing /
    if (path.endsWith('/')) path = path.slice(0, -1);

    entries.push({
      path,
      data: blockData,
      type: isDir ? 'directory' : 'file',
      mode: mode || (isDir ? 0o755 : 0o644),
      mtime,
    });
  }

  return entries;
}

// ─── Zip format (stored entries, no compression) ───

export interface ZipEntry {
  path: string;
  data: Uint8Array;
  isDirectory: boolean;
}

function writeU16LE(buf: Uint8Array, offset: number, value: number): void {
  buf[offset] = value & 0xff;
  buf[offset + 1] = (value >>> 8) & 0xff;
}

function writeU32LE(buf: Uint8Array, offset: number, value: number): void {
  buf[offset] = value & 0xff;
  buf[offset + 1] = (value >>> 8) & 0xff;
  buf[offset + 2] = (value >>> 16) & 0xff;
  buf[offset + 3] = (value >>> 24) & 0xff;
}

function readU16LE(buf: Uint8Array, offset: number): number {
  return buf[offset] | (buf[offset + 1] << 8);
}

function readU32LE(buf: Uint8Array, offset: number): number {
  return (buf[offset] | (buf[offset + 1] << 8) | (buf[offset + 2] << 16) | (buf[offset + 3] << 24)) >>> 0;
}

export function createZip(entries: ZipEntry[]): Uint8Array {
  const chunks: Uint8Array[] = [];
  const centralHeaders: Uint8Array[] = [];
  let offset = 0;

  for (const entry of entries) {
    let path = entry.path;
    if (path.startsWith('/')) path = path.slice(1);
    if (entry.isDirectory && !path.endsWith('/')) path += '/';

    const nameBytes = encode(path);
    const crc = entry.isDirectory ? 0 : crc32(entry.data);
    const size = entry.isDirectory ? 0 : entry.data.length;

    // Local file header (30 + name + data)
    const local = new Uint8Array(30 + nameBytes.length);
    writeU32LE(local, 0, 0x04034b50);   // Local file header signature
    writeU16LE(local, 4, 20);            // Version needed (2.0)
    writeU16LE(local, 6, 0);             // Flags
    writeU16LE(local, 8, 0);             // Compression (stored)
    writeU16LE(local, 10, 0);            // Mod time
    writeU16LE(local, 12, 0);            // Mod date
    writeU32LE(local, 14, crc);          // CRC-32
    writeU32LE(local, 18, size);         // Compressed size
    writeU32LE(local, 22, size);         // Uncompressed size
    writeU16LE(local, 26, nameBytes.length); // Name length
    writeU16LE(local, 28, 0);            // Extra field length
    local.set(nameBytes, 30);

    chunks.push(local);
    if (size > 0) chunks.push(entry.data);

    // Central directory header (46 + name)
    const central = new Uint8Array(46 + nameBytes.length);
    writeU32LE(central, 0, 0x02014b50);  // Central dir signature
    writeU16LE(central, 4, 20);           // Version made by
    writeU16LE(central, 6, 20);           // Version needed
    writeU16LE(central, 8, 0);            // Flags
    writeU16LE(central, 10, 0);           // Compression
    writeU16LE(central, 12, 0);           // Mod time
    writeU16LE(central, 14, 0);           // Mod date
    writeU32LE(central, 16, crc);         // CRC-32
    writeU32LE(central, 20, size);        // Compressed size
    writeU32LE(central, 24, size);        // Uncompressed size
    writeU16LE(central, 28, nameBytes.length); // Name length
    writeU16LE(central, 30, 0);           // Extra field length
    writeU16LE(central, 32, 0);           // Comment length
    writeU16LE(central, 34, 0);           // Disk number start
    writeU16LE(central, 36, 0);           // Internal attributes
    writeU32LE(central, 38, entry.isDirectory ? 0x10 : 0); // External attributes
    writeU32LE(central, 42, offset);      // Relative offset of local header
    central.set(nameBytes, 46);

    centralHeaders.push(central);
    offset += 30 + nameBytes.length + size;
  }

  const centralDirOffset = offset;
  let centralDirSize = 0;
  for (const h of centralHeaders) {
    chunks.push(h);
    centralDirSize += h.length;
  }

  // End of central directory record (22 bytes)
  const eocd = new Uint8Array(22);
  writeU32LE(eocd, 0, 0x06054b50);      // EOCD signature
  writeU16LE(eocd, 4, 0);                // Disk number
  writeU16LE(eocd, 6, 0);                // Central dir start disk
  writeU16LE(eocd, 8, entries.length);    // Entries on this disk
  writeU16LE(eocd, 10, entries.length);   // Total entries
  writeU32LE(eocd, 12, centralDirSize);   // Central dir size
  writeU32LE(eocd, 16, centralDirOffset); // Central dir offset
  writeU16LE(eocd, 20, 0);               // Comment length
  chunks.push(eocd);

  return concatBytes(...chunks);
}

export function parseZip(data: Uint8Array): ZipEntry[] {
  const entries: ZipEntry[] = [];

  // Find EOCD (last 22+ bytes)
  let eocdOffset = -1;
  for (let i = data.length - 22; i >= 0; i--) {
    if (readU32LE(data, i) === 0x06054b50) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset === -1) throw new Error('Invalid ZIP: EOCD not found');

  const entryCount = readU16LE(data, eocdOffset + 10);
  let centralOffset = readU32LE(data, eocdOffset + 16);

  for (let i = 0; i < entryCount; i++) {
    if (readU32LE(data, centralOffset) !== 0x02014b50) break;

    const nameLen = readU16LE(data, centralOffset + 28);
    const extraLen = readU16LE(data, centralOffset + 30);
    const commentLen = readU16LE(data, centralOffset + 32);
    const localOffset = readU32LE(data, centralOffset + 42);

    const nameBytes = data.subarray(centralOffset + 46, centralOffset + 46 + nameLen);
    let path = decode(nameBytes);

    const isDirectory = path.endsWith('/');
    if (isDirectory) path = path.slice(0, -1);

    // Read data from local file header
    const localNameLen = readU16LE(data, localOffset + 26);
    const localExtraLen = readU16LE(data, localOffset + 28);
    const compressedSize = readU32LE(data, localOffset + 18);
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;
    const entryData = isDirectory
      ? new Uint8Array(0)
      : data.slice(dataStart, dataStart + compressedSize);

    entries.push({ path, data: entryData, isDirectory });

    centralOffset += 46 + nameLen + extraLen + commentLen;
  }

  return entries;
}

// ─── VFS helper: recursively collect files ───

export function collectFiles(vfs: VFS, basePath: string, paths: string[]): TarEntry[] {
  const entries: TarEntry[] = [];

  function walk(absPath: string, relativeTo: string): void {
    const stat = vfs.stat(absPath);

    if (stat.type === 'directory') {
      entries.push({
        path: absPath.slice(relativeTo.length) || absPath,
        data: new Uint8Array(0),
        type: 'directory',
        mode: stat.mode,
        mtime: stat.mtime,
      });

      const children = vfs.readdir(absPath);
      for (const child of children) {
        const childPath = absPath === '/' ? `/${child.name}` : `${absPath}/${child.name}`;
        walk(childPath, relativeTo);
      }
    } else {
      entries.push({
        path: absPath.slice(relativeTo.length) || absPath,
        data: vfs.readFile(absPath),
        type: 'file',
        mode: stat.mode,
        mtime: stat.mtime,
      });
    }
  }

  for (const p of paths) {
    const absPath = resolve(basePath, p);
    const parent = dirname(absPath);
    const relBase = parent === '/' ? '/' : parent + '/';
    walk(absPath, relBase);
  }

  return entries;
}
