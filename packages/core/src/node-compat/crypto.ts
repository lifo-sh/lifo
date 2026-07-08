import { Buffer } from './buffer.js';
import { EventEmitter } from './events.js';

export function randomBytes(size: number): Buffer {
  const buf = Buffer.alloc(size);
  crypto.getRandomValues(buf);
  return buf;
}

export function randomUUID(): string {
  return crypto.randomUUID();
}

/** Algorithms our pure-JS createHash supports. Libraries like ssri filter against this. */
export function getHashes(): string[] {
  return ['md5', 'sha1', 'sha256', 'sha512'];
}

function digestOf(algo: string, chunks: Uint8Array[]): Uint8Array {
  let totalLen = 0;
  for (const c of chunks) totalLen += c.length;
  const merged = new Uint8Array(totalLen);
  let offset = 0;
  for (const c of chunks) { merged.set(c, offset); offset += c.length; }
  return algo === 'md5' ? md5sync(merged) : algo === 'sha1' ? sha1sync(merged) : algo === 'sha512' ? sha512sync(merged) : sha256sync(merged);
}

/**
 * Node's Hash is a Transform stream, not just an { update, digest } object.
 * Some packages (md5-file, used by expo-asset/metro for asset hashing) pipe a
 * file read stream into it and then read the digest via the 'readable' event.
 * So Hash is an EventEmitter exposing both the update/digest API and a minimal
 * writable/readable stream surface.
 */
class Hash extends EventEmitter {
  private chunks: Uint8Array[] = [];
  private _digest: Uint8Array | null = null;
  private _consumed = false;
  writable = true;
  readable = true;

  constructor(private algo: string) { super(); }

  update(data: string | Uint8Array): this {
    this.chunks.push(typeof data === 'string' ? new TextEncoder().encode(data) : data);
    return this;
  }

  digest(encoding?: string): string | Buffer {
    const result = this._digest ?? digestOf(this.algo, this.chunks);
    if (encoding === 'hex') return toHex(result);
    if (encoding === 'base64') return Buffer.from(result).toString('base64');
    // base64url (RFC 4648 §5): base64 with -/_ and no padding. write-file-atomic
    // builds its temp filename as `${path}.${sha256(data).digest('base64url')}`,
    // so a missing case here yielded a raw Buffer stringified into the filename
    // (binary garbage → ENOENT), breaking every atomic write (e.g. create-expo-app).
    if (encoding === 'base64url') {
      return Buffer.from(result).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
    }
    return Buffer.from(result);
  }

  // ── Stream surface (destination of a pipe) ──
  write(chunk: string | Uint8Array): boolean {
    this.update(chunk);
    return true;
  }

  end(chunk?: string | Uint8Array): this {
    if (chunk !== undefined && chunk !== null) this.update(chunk);
    this._digest = digestOf(this.algo, this.chunks);
    // Deliver events after listeners are attached (Readable.pipe wires 'end'
    // → dest.end() synchronously; consumers attach 'readable' before piping).
    queueMicrotask(() => {
      this.emit('readable');
      this.emit('finish');
      this.emit('end');
      this.emit('close');
    });
    return this;
  }

  read(): Buffer | null {
    if (this._consumed || !this._digest) return null;
    this._consumed = true;
    return Buffer.from(this._digest);
  }

  setEncoding(): this { return this; }
  pipe<T>(dest: T): T { return dest; }
}

export function createHash(algorithm: string): Hash {
  const algo = algorithm.toLowerCase().replace('-', '');
  if (algo !== 'sha256' && algo !== 'sha1' && algo !== 'md5' && algo !== 'sha512') {
    throw new Error(`Digest method not supported: ${algorithm} (only md5, sha1, sha256 and sha512 are supported)`);
  }
  return new Hash(algo);
}

export function randomInt(min: number, max?: number): number {
  if (max === undefined) {
    max = min;
    min = 0;
  }
  const range = max - min;
  const array = new Uint32Array(1);
  crypto.getRandomValues(array);
  return min + (array[0] % range);
}

// Node.js 19+ exposes Web Crypto APIs directly on the crypto module
export function getRandomValues<T extends ArrayBufferView>(array: T): T {
  return crypto.getRandomValues(array);
}

export const subtle = crypto.subtle;

// ── Sync one-shot hash (Node.js 21+ crypto.hash) ──
// crypto.subtle.digest is async-only, so we use a pure-JS fallback for sync hashing.
// This covers the common case: Vite calls crypto.hash('sha256', data, 'hex').

function rotl(x: number, n: number): number { return (x << n) | (x >>> (32 - n)); }

function sha1sync(data: Uint8Array): Uint8Array {
  let h0 = 0x67452301, h1 = 0xEFCDAB89, h2 = 0x98BADCFE, h3 = 0x10325476, h4 = 0xC3D2E1F0;
  const len = data.length;
  const bitLen = len * 8;
  const totalLen = Math.ceil((len + 9) / 64) * 64;
  const buf = new Uint8Array(totalLen);
  buf.set(data);
  buf[len] = 0x80;
  const view = new DataView(buf.buffer);
  view.setUint32(totalLen - 8, Math.floor(bitLen / 0x100000000), false);
  view.setUint32(totalLen - 4, bitLen >>> 0, false);
  const W = new Int32Array(80);
  for (let off = 0; off < buf.length; off += 64) {
    for (let i = 0; i < 16; i++) W[i] = view.getUint32(off + i * 4, false);
    for (let i = 16; i < 80; i++) W[i] = rotl(W[i-3] ^ W[i-8] ^ W[i-14] ^ W[i-16], 1);
    let a = h0, b = h1, c = h2, d = h3, e = h4;
    for (let i = 0; i < 80; i++) {
      let f: number, k: number;
      if (i < 20) { f = (b & c) | (~b & d); k = 0x5A827999; }
      else if (i < 40) { f = b ^ c ^ d; k = 0x6ED9EBA1; }
      else if (i < 60) { f = (b & c) | (b & d) | (c & d); k = 0x8F1BBCDC; }
      else { f = b ^ c ^ d; k = 0xCA62C1D6; }
      const t = (rotl(a, 5) + f + e + k + W[i]) | 0;
      e = d; d = c; c = rotl(b, 30); b = a; a = t;
    }
    h0 = (h0 + a) | 0; h1 = (h1 + b) | 0; h2 = (h2 + c) | 0; h3 = (h3 + d) | 0; h4 = (h4 + e) | 0;
  }
  const out = new Uint8Array(20);
  const ov = new DataView(out.buffer);
  ov.setUint32(0, h0, false); ov.setUint32(4, h1, false); ov.setUint32(8, h2, false);
  ov.setUint32(12, h3, false); ov.setUint32(16, h4, false);
  return out;
}

function rotr(x: number, n: number): number { return (x >>> n) | (x << (32 - n)); }

function sha256sync(data: Uint8Array): Uint8Array {
  const K = [
    0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
    0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
    0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
    0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
    0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
    0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
    0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
    0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2,
  ];
  let h0=0x6a09e667,h1=0xbb67ae85,h2=0x3c6ef372,h3=0xa54ff53a,h4=0x510e527f,h5=0x9b05688c,h6=0x1f83d9ab,h7=0x5be0cd19;
  const len = data.length;
  const bitLen = len * 8;
  // Padding: message + 0x80 + zeros + 8-byte big-endian bit length, total must be multiple of 64
  const totalLen = Math.ceil((len + 9) / 64) * 64;
  const buf = new Uint8Array(totalLen);
  buf.set(data);
  buf[len] = 0x80;
  const view = new DataView(buf.buffer);
  // 64-bit big-endian bit length (high 32 bits then low 32 bits)
  view.setUint32(totalLen - 8, Math.floor(bitLen / 0x100000000), false);
  view.setUint32(totalLen - 4, bitLen >>> 0, false);
  // Process 64-byte blocks
  const W = new Int32Array(64);
  for (let off = 0; off < buf.length; off += 64) {
    for (let i = 0; i < 16; i++) W[i] = view.getUint32(off + i * 4, false);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(W[i-15],7) ^ rotr(W[i-15],18) ^ (W[i-15]>>>3);
      const s1 = rotr(W[i-2],17) ^ rotr(W[i-2],19) ^ (W[i-2]>>>10);
      W[i] = (W[i-16] + s0 + W[i-7] + s1) | 0;
    }
    let a=h0,b=h1,c=h2,d=h3,e=h4,f=h5,g=h6,h=h7;
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e,6) ^ rotr(e,11) ^ rotr(e,25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + S1 + ch + K[i] + W[i]) | 0;
      const S0 = rotr(a,2) ^ rotr(a,13) ^ rotr(a,22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) | 0;
      h=g; g=f; f=e; e=(d+t1)|0; d=c; c=b; b=a; a=(t1+t2)|0;
    }
    h0=(h0+a)|0; h1=(h1+b)|0; h2=(h2+c)|0; h3=(h3+d)|0; h4=(h4+e)|0; h5=(h5+f)|0; h6=(h6+g)|0; h7=(h7+h)|0;
  }
  const out = new Uint8Array(32);
  const ov = new DataView(out.buffer);
  ov.setUint32(0,h0,false); ov.setUint32(4,h1,false); ov.setUint32(8,h2,false); ov.setUint32(12,h3,false);
  ov.setUint32(16,h4,false); ov.setUint32(20,h5,false); ov.setUint32(24,h6,false); ov.setUint32(28,h7,false);
  return out;
}

/** Pure-JS SHA-512 (BigInt-based 64-bit arithmetic). ssri uses sha512 for its default integrity strings. */
function sha512sync(data: Uint8Array): Uint8Array {
  const MASK = (1n << 64n) - 1n;
  const rotr = (x: bigint, n: bigint) => ((x >> n) | (x << (64n - n))) & MASK;

  const K: bigint[] = [
    0x428a2f98d728ae22n,0x7137449123ef65cdn,0xb5c0fbcfec4d3b2fn,0xe9b5dba58189dbbcn,
    0x3956c25bf348b538n,0x59f111f1b605d019n,0x923f82a4af194f9bn,0xab1c5ed5da6d8118n,
    0xd807aa98a3030242n,0x12835b0145706fben,0x243185be4ee4b28cn,0x550c7dc3d5ffb4e2n,
    0x72be5d74f27b896fn,0x80deb1fe3b1696b1n,0x9bdc06a725c71235n,0xc19bf174cf692694n,
    0xe49b69c19ef14ad2n,0xefbe4786384f25e3n,0x0fc19dc68b8cd5b5n,0x240ca1cc77ac9c65n,
    0x2de92c6f592b0275n,0x4a7484aa6ea6e483n,0x5cb0a9dcbd41fbd4n,0x76f988da831153b5n,
    0x983e5152ee66dfabn,0xa831c66d2db43210n,0xb00327c898fb213fn,0xbf597fc7beef0ee4n,
    0xc6e00bf33da88fc2n,0xd5a79147930aa725n,0x06ca6351e003826fn,0x142929670a0e6e70n,
    0x27b70a8546d22ffcn,0x2e1b21385c26c926n,0x4d2c6dfc5ac42aedn,0x53380d139d95b3dfn,
    0x650a73548baf63den,0x766a0abb3c77b2a8n,0x81c2c92e47edaee6n,0x92722c851482353bn,
    0xa2bfe8a14cf10364n,0xa81a664bbc423001n,0xc24b8b70d0f89791n,0xc76c51a30654be30n,
    0xd192e819d6ef5218n,0xd69906245565a910n,0xf40e35855771202an,0x106aa07032bbd1b8n,
    0x19a4c116b8d2d0c8n,0x1e376c085141ab53n,0x2748774cdf8eeb99n,0x34b0bcb5e19b48a8n,
    0x391c0cb3c5c95a63n,0x4ed8aa4ae3418acbn,0x5b9cca4f7763e373n,0x682e6ff3d6b2b8a3n,
    0x748f82ee5defb2fcn,0x78a5636f43172f60n,0x84c87814a1f0ab72n,0x8cc702081a6439ecn,
    0x90befffa23631e28n,0xa4506cebde82bde9n,0xbef9a3f7b2c67915n,0xc67178f2e372532bn,
    0xca273eceea26619cn,0xd186b8c721c0c207n,0xeada7dd6cde0eb1en,0xf57d4f7fee6ed178n,
    0x06f067aa72176fban,0x0a637dc5a2c898a6n,0x113f9804bef90daen,0x1b710b35131c471bn,
    0x28db77f523047d84n,0x32caab7b40c72493n,0x3c9ebe0a15c9bebcn,0x431d67c49c100d4cn,
    0x4cc5d4becb3e42b6n,0x597f299cfc657e2an,0x5fcb6fab3ad6faecn,0x6c44198c4a475817n,
  ];
  let h0=0x6a09e667f3bcc908n,h1=0xbb67ae8584caa73bn,h2=0x3c6ef372fe94f82bn,h3=0xa54ff53a5f1d36f1n;
  let h4=0x510e527fade682d1n,h5=0x9b05688c2b3e6c1fn,h6=0x1f83d9abfb41bd6bn,h7=0x5be0cd19137e2179n;

  const len = data.length;
  // Padding: message + 0x80 + zeros + 16-byte big-endian bit length, total multiple of 128.
  const totalLen = Math.ceil((len + 17) / 128) * 128;
  const buf = new Uint8Array(totalLen);
  buf.set(data);
  buf[len] = 0x80;
  const view = new DataView(buf.buffer);
  view.setBigUint64(totalLen - 8, (BigInt(len) * 8n) & MASK, false); // low 64 bits of bit length

  const W: bigint[] = new Array(80);
  for (let off = 0; off < buf.length; off += 128) {
    for (let i = 0; i < 16; i++) W[i] = view.getBigUint64(off + i * 8, false);
    for (let i = 16; i < 80; i++) {
      const s0 = rotr(W[i-15],1n) ^ rotr(W[i-15],8n) ^ (W[i-15] >> 7n);
      const s1 = rotr(W[i-2],19n) ^ rotr(W[i-2],61n) ^ (W[i-2] >> 6n);
      W[i] = (W[i-16] + s0 + W[i-7] + s1) & MASK;
    }
    let a=h0,b=h1,c=h2,d=h3,e=h4,f=h5,g=h6,h=h7;
    for (let i = 0; i < 80; i++) {
      const S1 = rotr(e,14n) ^ rotr(e,18n) ^ rotr(e,41n);
      const ch = (e & f) ^ ((e ^ MASK) & g);
      const t1 = (h + S1 + ch + K[i] + W[i]) & MASK;
      const S0 = rotr(a,28n) ^ rotr(a,34n) ^ rotr(a,39n);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) & MASK;
      h=g; g=f; f=e; e=(d+t1)&MASK; d=c; c=b; b=a; a=(t1+t2)&MASK;
    }
    h0=(h0+a)&MASK; h1=(h1+b)&MASK; h2=(h2+c)&MASK; h3=(h3+d)&MASK;
    h4=(h4+e)&MASK; h5=(h5+f)&MASK; h6=(h6+g)&MASK; h7=(h7+h)&MASK;
  }
  const out = new Uint8Array(64);
  const ov = new DataView(out.buffer);
  ov.setBigUint64(0,h0,false); ov.setBigUint64(8,h1,false); ov.setBigUint64(16,h2,false); ov.setBigUint64(24,h3,false);
  ov.setBigUint64(32,h4,false); ov.setBigUint64(40,h5,false); ov.setBigUint64(48,h6,false); ov.setBigUint64(56,h7,false);
  return out;
}

function toHex(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += bytes[i].toString(16).padStart(2, '0');
  return s;
}

/** Node.js 21+ one-shot sync hash: crypto.hash(algo, data, encoding) */
export function hash(algorithm: string, data: string | Uint8Array, outputEncoding: string = 'hex'): string {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  const algo = algorithm.toLowerCase().replace('-', '');
  const digest = algo === 'md5' ? md5sync(bytes) : algo === 'sha1' ? sha1sync(bytes) : algo === 'sha512' ? sha512sync(bytes) : algo === 'sha256' ? sha256sync(bytes) : null;
  if (!digest) {
    throw new Error(`crypto.hash: only md5, sha1, sha256 and sha512 are supported in browser, got ${algorithm}`);
  }
  if (outputEncoding === 'base64') return Buffer.from(digest).toString('base64');
  return toHex(digest);
}

/** Pure-JS MD5 (RFC 1321). Web Crypto has no md5, but Metro needs it for cache keys / module ids. */
function md5sync(data: Uint8Array): Uint8Array {
  const rotl = (x: number, c: number) => (x << c) | (x >>> (32 - c));
  const add = (a: number, b: number) => (a + b) | 0;

  // Pad the message: append 0x80, zeros, then the 64-bit bit-length (LE).
  const origLen = data.length;
  const bitLen = origLen * 8;
  const withPad = ((origLen + 8) >>> 6) + 1; // number of 64-byte blocks
  const total = withPad * 64;
  const msg = new Uint8Array(total);
  msg.set(data);
  msg[origLen] = 0x80;
  // 64-bit length (little-endian); only the low 32 bits are realistic here.
  const dv = new DataView(msg.buffer);
  dv.setUint32(total - 8, bitLen >>> 0, true);
  dv.setUint32(total - 4, Math.floor(bitLen / 0x100000000) >>> 0, true);

  const S = [
    7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
    5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
    4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
    6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
  ];
  const K = new Int32Array(64);
  for (let i = 0; i < 64; i++) K[i] = (Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296)) | 0;

  let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
  const M = new Int32Array(16);
  for (let off = 0; off < total; off += 64) {
    for (let i = 0; i < 16; i++) M[i] = dv.getInt32(off + i * 4, true);
    let A = a0, B = b0, C = c0, D = d0;
    for (let i = 0; i < 64; i++) {
      let F: number, g: number;
      if (i < 16) { F = (B & C) | (~B & D); g = i; }
      else if (i < 32) { F = (D & B) | (~D & C); g = (5 * i + 1) & 15; }
      else if (i < 48) { F = B ^ C ^ D; g = (3 * i + 5) & 15; }
      else { F = C ^ (B | ~D); g = (7 * i) & 15; }
      F = add(add(add(F, A), K[i]), M[g]);
      A = D; D = C; C = B;
      B = add(B, rotl(F, S[i]));
    }
    a0 = add(a0, A); b0 = add(b0, B); c0 = add(c0, C); d0 = add(d0, D);
  }

  const out = new Uint8Array(16);
  const odv = new DataView(out.buffer);
  odv.setInt32(0, a0, true); odv.setInt32(4, b0, true); odv.setInt32(8, c0, true); odv.setInt32(12, d0, true);
  return out;
}

export default { randomBytes, randomUUID, createHash, randomInt, getRandomValues, subtle, hash, getHashes };
