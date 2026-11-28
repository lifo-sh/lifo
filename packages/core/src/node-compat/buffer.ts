const encoder = new TextEncoder();
const decoder = new TextDecoder();

type Encoding = 'utf8' | 'utf16le' | 'latin1' | 'ascii' | 'base64' | 'base64url' | 'hex';

/** Node's encoding names and aliases; null for one Node doesn't know. */
function normalizeEncoding(enc: unknown): Encoding | null {
  if (enc === undefined || enc === null) return 'utf8';
  switch (String(enc).toLowerCase()) {
    case 'utf8': case 'utf-8': return 'utf8';
    case 'utf16le': case 'utf-16le': case 'ucs2': case 'ucs-2': return 'utf16le';
    case 'latin1': case 'binary': return 'latin1';
    case 'ascii': return 'ascii';
    case 'base64': return 'base64';
    case 'base64url': return 'base64url';
    case 'hex': return 'hex';
    default: return null;
  }
}

function base64Bytes(str: string): Uint8Array {
  // Node accepts both alphabets and skips what isn't base64; atob does neither.
  let clean = str.replace(/-/g, '+').replace(/_/g, '/').replace(/[^A-Za-z0-9+/]/g, '');
  if (clean.length % 4 === 1) clean = clean.slice(0, -1);
  while (clean.length % 4 !== 0) clean += '=';
  const binary = atob(clean);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/** A string's bytes in `enc`, as Node encodes them. */
function encodeString(str: string, enc: Encoding): Uint8Array {
  switch (enc) {
    case 'utf16le': {
      const out = new Uint8Array(str.length * 2);
      for (let i = 0; i < str.length; i++) {
        const c = str.charCodeAt(i);
        out[i * 2] = c & 0xff;
        out[i * 2 + 1] = c >> 8;
      }
      return out;
    }
    case 'latin1':
    case 'ascii': {
      const out = new Uint8Array(str.length);
      for (let i = 0; i < str.length; i++) out[i] = str.charCodeAt(i) & 0xff;
      return out;
    }
    case 'base64':
    case 'base64url':
      return base64Bytes(str);
    case 'hex': {
      const n = Math.floor(str.length / 2);
      const out = new Uint8Array(n);
      for (let i = 0; i < n; i++) {
        const byte = parseInt(str.substring(i * 2, i * 2 + 2), 16);
        if (Number.isNaN(byte)) return out.subarray(0, i); // Node stops at the first bad pair
        out[i] = byte;
      }
      return out;
    }
    default:
      return encoder.encode(str);
  }
}

/** Bytes as a string in `enc`, as Node decodes them. */
function decodeBytes(bytes: Uint8Array, enc: Encoding): string {
  switch (enc) {
    case 'utf16le': {
      let out = '';
      for (let i = 0; i + 1 < bytes.length; i += 2) out += String.fromCharCode(bytes[i] | (bytes[i + 1] << 8));
      return out;
    }
    case 'latin1': {
      let out = '';
      for (let i = 0; i < bytes.length; i++) out += String.fromCharCode(bytes[i]);
      return out;
    }
    case 'ascii': {
      let out = '';
      for (let i = 0; i < bytes.length; i++) out += String.fromCharCode(bytes[i] & 0x7f);
      return out;
    }
    case 'base64':
    case 'base64url': {
      let binary = '';
      for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
      const b64 = btoa(binary);
      return enc === 'base64' ? b64 : b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    }
    case 'hex': {
      let hex = '';
      for (let i = 0; i < bytes.length; i++) hex += bytes[i].toString(16).padStart(2, '0');
      return hex;
    }
    default:
      return decoder.decode(bytes);
  }
}

function unknownEncoding(enc: unknown): TypeError {
  const err = new TypeError(`Unknown encoding: ${String(enc)}`) as TypeError & { code: string };
  err.code = 'ERR_UNKNOWN_ENCODING';
  return err;
}

const dataView = (b: Uint8Array) => new DataView(b.buffer, b.byteOffset, b.byteLength);
/** Two's complement of a `byteLength`-byte unsigned value, and back. */
const signed = (v: number, byteLength: number) => (v >= 2 ** (8 * byteLength - 1) ? v - 2 ** (8 * byteLength) : v);
const unsigned = (v: number, byteLength: number) => (v < 0 ? v + 2 ** (8 * byteLength) : v);

export class Buffer extends Uint8Array {
  // Use overloaded signatures to satisfy Uint8Array's static from
  static from(value: string | Uint8Array | number[] | ArrayBuffer | SharedArrayBuffer | ArrayLike<number> | Iterable<number>, encodingOrMapFn?: string | number | ((v: number, k: number) => number), _thisArg?: unknown): Buffer {
    if (typeof value === 'string') {
      const enc = normalizeEncoding(encodingOrMapFn);
      if (!enc) throw unknownEncoding(encodingOrMapFn);
      const bytes = encodeString(value, enc);
      const buf = new Buffer(bytes.length);
      buf.set(bytes);
      return buf;
    }
    if (value instanceof ArrayBuffer || (typeof SharedArrayBuffer !== 'undefined' && value instanceof SharedArrayBuffer)) {
      // Node: a view sharing the memory, not a copy. es-module-lexer (in Vite) writes its
      // input into wasm memory through Buffer.from(memory.buffer, offset, length).write(...).
      const byteOffset = typeof encodingOrMapFn === 'number' ? encodingOrMapFn : 0;
      const length = typeof _thisArg === 'number' ? _thisArg : value.byteLength - byteOffset;
      return new Buffer(value as ArrayBuffer, byteOffset, length);
    }
    if (value instanceof Uint8Array) {
      const buf = new Buffer(value.length);
      buf.set(value);
      return buf;
    }
    // ArrayLike<number> or number[]
    const arr = value as ArrayLike<number>;
    const buf = new Buffer(arr.length);
    for (let i = 0; i < arr.length; i++) buf[i] = arr[i];
    return buf;
  }

  static alloc(size: number, fill?: number): Buffer {
    const buf = new Buffer(size);
    if (fill !== undefined) buf.fill(fill);
    return buf;
  }

  static allocUnsafe(size: number): Buffer {
    return new Buffer(size);
  }

  // Node pools allocUnsafe but not allocUnsafeSlow; for us they're identical.
  // safe-buffer only uses the real Buffer when from/alloc/allocUnsafe AND
  // allocUnsafeSlow all exist — otherwise it wraps it and drops static methods
  // like isBuffer (non-enumerable, so its for..in copy misses them).
  static allocUnsafeSlow(size: number): Buffer {
    return new Buffer(size);
  }

  static isBuffer(obj: unknown): obj is Buffer {
    return obj instanceof Buffer;
  }

  static concat(list: (Uint8Array | Buffer)[], totalLength?: number): Buffer {
    const len = totalLength ?? list.reduce((sum, b) => sum + b.length, 0);
    const result = Buffer.alloc(len);
    let offset = 0;
    for (const buf of list) {
      const slice = buf.subarray(0, Math.min(buf.length, len - offset));
      result.set(slice, offset);
      offset += slice.length;
      if (offset >= len) break;
    }
    return result;
  }

  static byteLength(str: string | ArrayBufferView | ArrayBuffer, encoding?: string): number {
    if (typeof str !== 'string') return str.byteLength;
    if (encoding === 'base64' || encoding === 'base64url') {
      const cleaned = str.replace(/[^A-Za-z0-9+/_-]/g, '');
      return Math.floor(cleaned.length * 3 / 4);
    }
    return encodeString(str, normalizeEncoding(encoding) ?? 'utf8').length;
  }

  toString(encoding?: string, start?: number, end?: number): string {
    const enc = normalizeEncoding(encoding);
    if (!enc) throw unknownEncoding(encoding);
    const slice = (start !== undefined || end !== undefined)
      ? this.subarray(start ?? 0, end ?? this.length)
      : this;
    return decodeBytes(slice, enc);
  }

  /** Node's forms: write(string[, offset[, length]][, encoding]). */
  write(str: string, offsetOrEncoding?: number | string, lengthOrEncoding?: number | string, encodingArg?: string): number {
    let offset = 0;
    let length: number | undefined;
    let encoding: unknown = encodingArg;
    if (typeof offsetOrEncoding === 'string') {
      encoding = offsetOrEncoding;
    } else {
      offset = offsetOrEncoding ?? 0;
      if (typeof lengthOrEncoding === 'string') encoding = lengthOrEncoding;
      else length = lengthOrEncoding;
    }
    const enc = normalizeEncoding(encoding);
    if (!enc) throw unknownEncoding(encoding);
    const room = Math.max(0, this.length - offset);
    const maxLen = Math.min(length ?? room, room);
    let bytes = encodeString(str, enc);
    if (bytes.length > maxLen) {
      bytes = bytes.subarray(0, maxLen);
      // Node doesn't write half a character.
      if (enc === 'utf16le') bytes = bytes.subarray(0, maxLen - (maxLen % 2));
      else if (enc === 'utf8') {
        let end = maxLen;
        let i = end - 1;
        while (i >= 0 && (bytes[i] & 0xc0) === 0x80) i--; // back to the last lead byte
        if (i >= 0) {
          const lead = bytes[i];
          const need = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1;
          if (i + need > end) end = i;
        }
        bytes = bytes.subarray(0, end);
      }
    }
    this.set(bytes, offset);
    return bytes.length;
  }

  toJSON(): { type: 'Buffer'; data: number[] } {
    return { type: 'Buffer', data: Array.from(this) };
  }

  copy(target: Buffer | Uint8Array, targetStart = 0, sourceStart = 0, sourceEnd = this.length): number {
    const slice = this.subarray(sourceStart, sourceEnd);
    const len = Math.min(slice.length, target.length - targetStart);
    target.set(slice.subarray(0, len), targetStart);
    return len;
  }

  equals(other: Uint8Array): boolean {
    if (this.length !== other.length) return false;
    for (let i = 0; i < this.length; i++) {
      if (this[i] !== other[i]) return false;
    }
    return true;
  }

  compare(other: Uint8Array): number {
    const len = Math.min(this.length, other.length);
    for (let i = 0; i < len; i++) {
      if (this[i] < other[i]) return -1;
      if (this[i] > other[i]) return 1;
    }
    if (this.length < other.length) return -1;
    if (this.length > other.length) return 1;
    return 0;
  }

  slice(start?: number, end?: number): Buffer {
    // Node's Buffer#slice SHARES memory (it's an alias of subarray), unlike
    // Uint8Array#slice which copies.
    return this.subarray(start, end);
  }

  subarray(start?: number, end?: number): Buffer {
    // MUST return a shared view (Node semantics) — the species constructor
    // already produces a Buffer over the same memory. The old Buffer.from()
    // wrapper COPIED, which silently broke every consumer that writes through
    // the view: msgpackr encodes strings via
    // textEncoder.encodeInto(str, target.subarray(pos)), so Metro's binary
    // transform cache (@expo/metro-config BinaryFileStore .mp files) was
    // written with all strings missing — the second `expo start` run then
    // decoded garbage and crashed with "dependencies is not iterable".
    return super.subarray(start, end) as Buffer;
  }

  // ─── Integer read methods (big-endian) ───

  readUInt8(offset = 0): number {
    return this[offset];
  }

  readUInt16BE(offset = 0): number {
    return (this[offset] << 8) | this[offset + 1];
  }

  readUInt32BE(offset = 0): number {
    return (
      (this[offset] * 0x1000000) +
      ((this[offset + 1] << 16) |
       (this[offset + 2] << 8) |
        this[offset + 3])
    );
  }

  readInt8(offset = 0): number {
    const val = this[offset];
    return val & 0x80 ? val - 0x100 : val;
  }

  readInt16BE(offset = 0): number {
    const val = (this[offset] << 8) | this[offset + 1];
    return val & 0x8000 ? val - 0x10000 : val;
  }

  readInt32BE(offset = 0): number {
    return (
      (this[offset] << 24) |
      (this[offset + 1] << 16) |
      (this[offset + 2] << 8) |
       this[offset + 3]
    );
  }

  // ─── Integer read methods (little-endian) ───

  readUInt16LE(offset = 0): number {
    return this[offset] | (this[offset + 1] << 8);
  }

  readUInt32LE(offset = 0): number {
    return (
      this[offset] +
      (this[offset + 1] << 8) +
      (this[offset + 2] << 16) +
      (this[offset + 3] * 0x1000000)
    );
  }

  readInt16LE(offset = 0): number {
    const val = this[offset] | (this[offset + 1] << 8);
    return val & 0x8000 ? val - 0x10000 : val;
  }

  readInt32LE(offset = 0): number {
    return (
      this[offset] |
      (this[offset + 1] << 8) |
      (this[offset + 2] << 16) |
      (this[offset + 3] << 24)
    );
  }

  // ─── Integer write methods (big-endian) ───

  writeUInt8(value: number, offset = 0): number {
    this[offset] = value & 0xff;
    return offset + 1;
  }

  writeUInt16BE(value: number, offset = 0): number {
    this[offset] = (value >>> 8) & 0xff;
    this[offset + 1] = value & 0xff;
    return offset + 2;
  }

  writeUInt32BE(value: number, offset = 0): number {
    this[offset] = (value >>> 24) & 0xff;
    this[offset + 1] = (value >>> 16) & 0xff;
    this[offset + 2] = (value >>> 8) & 0xff;
    this[offset + 3] = value & 0xff;
    return offset + 4;
  }

  /**
   * Variable-width unsigned write, 1–6 bytes, big-endian.
   *
   * Needed by `ws`: a WebSocket frame carrying more than 65535 bytes uses the
   * 64-bit length form, which `ws` writes with `writeUIntBE(len, offset, 6)`.
   * Without this, any in-VM WebSocket message over ~64 KB threw
   * "target.writeUIntBE is not a function" — so HMR payloads and large realtime
   * messages failed while small ones worked.
   *
   * Uses arithmetic rather than bit shifts: `>>>` truncates to 32 bits, and this
   * has to stay exact up to 6 bytes (2^48).
   */
  writeUIntBE(value: number, offset = 0, byteLength = 1): number {
    let remaining = value;
    for (let i = byteLength - 1; i >= 0; i--) {
      this[offset + i] = remaining % 256;
      remaining = Math.floor(remaining / 256);
    }
    return offset + byteLength;
  }

  /** Variable-width unsigned write, 1–6 bytes, little-endian. */
  writeUIntLE(value: number, offset = 0, byteLength = 1): number {
    let remaining = value;
    for (let i = 0; i < byteLength; i++) {
      this[offset + i] = remaining % 256;
      remaining = Math.floor(remaining / 256);
    }
    return offset + byteLength;
  }

  /** Variable-width unsigned read, 1–6 bytes, big-endian. */
  readUIntBE(offset = 0, byteLength = 1): number {
    let value = 0;
    for (let i = 0; i < byteLength; i++) value = value * 256 + this[offset + i];
    return value;
  }

  /** Variable-width unsigned read, 1–6 bytes, little-endian. */
  readUIntLE(offset = 0, byteLength = 1): number {
    let value = 0;
    for (let i = byteLength - 1; i >= 0; i--) value = value * 256 + this[offset + i];
    return value;
  }

  writeInt8(value: number, offset = 0): number {
    this[offset] = value & 0xff;
    return offset + 1;
  }

  writeInt16BE(value: number, offset = 0): number {
    this[offset] = (value >>> 8) & 0xff;
    this[offset + 1] = value & 0xff;
    return offset + 2;
  }

  writeInt32BE(value: number, offset = 0): number {
    this[offset] = (value >>> 24) & 0xff;
    this[offset + 1] = (value >>> 16) & 0xff;
    this[offset + 2] = (value >>> 8) & 0xff;
    this[offset + 3] = value & 0xff;
    return offset + 4;
  }

  // ─── Integer write methods (little-endian) ───

  writeUInt16LE(value: number, offset = 0): number {
    this[offset] = value & 0xff;
    this[offset + 1] = (value >>> 8) & 0xff;
    return offset + 2;
  }

  writeUInt32LE(value: number, offset = 0): number {
    this[offset] = value & 0xff;
    this[offset + 1] = (value >>> 8) & 0xff;
    this[offset + 2] = (value >>> 16) & 0xff;
    this[offset + 3] = (value >>> 24) & 0xff;
    return offset + 4;
  }

  writeInt16LE(value: number, offset = 0): number {
    this[offset] = value & 0xff;
    this[offset + 1] = (value >>> 8) & 0xff;
    return offset + 2;
  }

  writeInt32LE(value: number, offset = 0): number {
    this[offset] = value & 0xff;
    this[offset + 1] = (value >>> 8) & 0xff;
    this[offset + 2] = (value >>> 16) & 0xff;
    this[offset + 3] = (value >>> 24) & 0xff;
    return offset + 4;
  }

  // ─── Floats, doubles, 64-bit and signed variable-width integers ───
  // (webpack's cache serializer writes doubles; out of range throws a RangeError, as in Node)

  readFloatLE(offset = 0): number { return dataView(this).getFloat32(offset, true); }
  readFloatBE(offset = 0): number { return dataView(this).getFloat32(offset, false); }
  readDoubleLE(offset = 0): number { return dataView(this).getFloat64(offset, true); }
  readDoubleBE(offset = 0): number { return dataView(this).getFloat64(offset, false); }
  writeFloatLE(value: number, offset = 0): number { dataView(this).setFloat32(offset, value, true); return offset + 4; }
  writeFloatBE(value: number, offset = 0): number { dataView(this).setFloat32(offset, value, false); return offset + 4; }
  writeDoubleLE(value: number, offset = 0): number { dataView(this).setFloat64(offset, value, true); return offset + 8; }
  writeDoubleBE(value: number, offset = 0): number { dataView(this).setFloat64(offset, value, false); return offset + 8; }
  readBigInt64LE(offset = 0): bigint { return dataView(this).getBigInt64(offset, true); }
  readBigInt64BE(offset = 0): bigint { return dataView(this).getBigInt64(offset, false); }
  readBigUInt64LE(offset = 0): bigint { return dataView(this).getBigUint64(offset, true); }
  readBigUInt64BE(offset = 0): bigint { return dataView(this).getBigUint64(offset, false); }
  writeBigInt64LE(value: bigint, offset = 0): number { dataView(this).setBigInt64(offset, value, true); return offset + 8; }
  writeBigInt64BE(value: bigint, offset = 0): number { dataView(this).setBigInt64(offset, value, false); return offset + 8; }
  writeBigUInt64LE(value: bigint, offset = 0): number { dataView(this).setBigUint64(offset, value, true); return offset + 8; }
  writeBigUInt64BE(value: bigint, offset = 0): number { dataView(this).setBigUint64(offset, value, false); return offset + 8; }

  readIntLE(offset = 0, byteLength = 1): number { return signed(this.readUIntLE(offset, byteLength), byteLength); }
  readIntBE(offset = 0, byteLength = 1): number { return signed(this.readUIntBE(offset, byteLength), byteLength); }
  writeIntLE(value: number, offset = 0, byteLength = 1): number { return this.writeUIntLE(unsigned(value, byteLength), offset, byteLength); }
  writeIntBE(value: number, offset = 0, byteLength = 1): number { return this.writeUIntBE(unsigned(value, byteLength), offset, byteLength); }

  // ─── Search methods ───

  indexOf(value: number | Uint8Array | string, byteOffset?: number, encoding?: string): number {
    const start = byteOffset ?? 0;
    if (typeof value === 'number') {
      for (let i = start; i < this.length; i++) {
        if (this[i] === value) return i;
      }
      return -1;
    }
    const needle = typeof value === 'string'
      ? Buffer.from(value, encoding)
      : value;
    if (needle.length === 0) return start;
    for (let i = start; i <= this.length - needle.length; i++) {
      let match = true;
      for (let j = 0; j < needle.length; j++) {
        if (this[i + j] !== needle[j]) { match = false; break; }
      }
      if (match) return i;
    }
    return -1;
  }

  lastIndexOf(value: number | Uint8Array | string, byteOffset?: number, encoding?: string): number {
    if (typeof value === 'number') {
      const start = byteOffset ?? this.length - 1;
      for (let i = start; i >= 0; i--) {
        if (this[i] === value) return i;
      }
      return -1;
    }
    const needle = typeof value === 'string'
      ? Buffer.from(value, encoding)
      : value;
    if (needle.length === 0) return byteOffset ?? this.length;
    const start = byteOffset != null ? Math.min(byteOffset, this.length - needle.length) : this.length - needle.length;
    for (let i = start; i >= 0; i--) {
      let match = true;
      for (let j = 0; j < needle.length; j++) {
        if (this[i + j] !== needle[j]) { match = false; break; }
      }
      if (match) return i;
    }
    return -1;
  }

  includes(value: number | Uint8Array | string, byteOffset?: number, encoding?: string): boolean {
    return this.indexOf(value, byteOffset, encoding) !== -1;
  }
}

// ─── Node's lowercase "Uint" aliases ───
// readUint8, writeUint32LE, readBigUint64LE, ...: the same methods under Node's other spelling.
for (const name of Object.getOwnPropertyNames(Buffer.prototype)) {
  if (!/^(read|write)(Big)?UInt/.test(name)) continue;
  const alias = name.replace('UInt', 'Uint');
  if (!(alias in Buffer.prototype)) {
    Object.defineProperty(Buffer.prototype, alias, { value: (Buffer.prototype as unknown as Record<string, unknown>)[name], writable: true, configurable: true });
  }
}

export default Buffer;
