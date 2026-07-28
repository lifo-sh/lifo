const encoder = new TextEncoder();
const decoder = new TextDecoder();

export class Buffer extends Uint8Array {
  // Use overloaded signatures to satisfy Uint8Array's static from
  static from(value: string | Uint8Array | number[] | ArrayBuffer | ArrayLike<number> | Iterable<number>, encodingOrMapFn?: string | ((v: number, k: number) => number), _thisArg?: unknown): Buffer {
    if (typeof value === 'string') {
      const encoding = encodingOrMapFn as string | undefined;
      if (encoding === 'base64') {
        const binary = atob(value);
        const buf = new Buffer(binary.length);
        for (let i = 0; i < binary.length; i++) buf[i] = binary.charCodeAt(i);
        return buf;
      }
      if (encoding === 'hex') {
        const buf = new Buffer(value.length / 2);
        for (let i = 0; i < value.length; i += 2) {
          buf[i / 2] = parseInt(value.substring(i, i + 2), 16);
        }
        return buf;
      }
      // utf-8 default
      const bytes = encoder.encode(value);
      const buf = new Buffer(bytes.length);
      buf.set(bytes);
      return buf;
    }
    if (value instanceof ArrayBuffer) {
      const buf = new Buffer(value.byteLength);
      buf.set(new Uint8Array(value));
      return buf;
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

  static byteLength(str: string, encoding?: string): number {
    if (encoding === 'base64') {
      // Remove padding and compute
      const cleaned = str.replace(/[^A-Za-z0-9+/]/g, '');
      return Math.floor(cleaned.length * 3 / 4);
    }
    if (encoding === 'hex') {
      return str.length / 2;
    }
    return encoder.encode(str).length;
  }

  toString(encoding?: string, start?: number, end?: number): string {
    const slice = (start !== undefined || end !== undefined)
      ? this.subarray(start ?? 0, end ?? this.length)
      : this;
    if (encoding === 'base64') {
      let binary = '';
      for (let i = 0; i < slice.length; i++) binary += String.fromCharCode(slice[i]);
      return btoa(binary);
    }
    if (encoding === 'hex') {
      let hex = '';
      for (let i = 0; i < slice.length; i++) hex += slice[i].toString(16).padStart(2, '0');
      return hex;
    }
    // utf-8 default
    return decoder.decode(slice);
  }

  write(str: string, offset?: number, length?: number, encoding?: string): number {
    const start = offset ?? 0;
    const maxLen = length ?? this.length - start;

    let bytes: Uint8Array;
    if (encoding === 'hex') {
      // Each pair of hex chars = 1 byte
      const byteLen = Math.min(Math.floor(str.length / 2), maxLen);
      bytes = new Uint8Array(byteLen);
      for (let i = 0; i < byteLen; i++) {
        bytes[i] = parseInt(str.substring(i * 2, i * 2 + 2), 16);
      }
    } else if (encoding === 'base64') {
      const binary = atob(str);
      const byteLen = Math.min(binary.length, maxLen);
      bytes = new Uint8Array(byteLen);
      for (let i = 0; i < byteLen; i++) bytes[i] = binary.charCodeAt(i);
    } else {
      bytes = encoder.encode(str);
    }

    const toWrite = Math.min(bytes.length, maxLen);
    this.set(bytes.subarray(0, toWrite), start);
    return toWrite;
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

export default Buffer;
