import { Buffer } from './buffer.js';

export function randomBytes(size: number): Buffer {
  const buf = Buffer.alloc(size);
  crypto.getRandomValues(buf);
  return buf;
}

export function randomUUID(): string {
  return crypto.randomUUID();
}

interface HashObject {
  update(data: string | Uint8Array): HashObject;
  digest(encoding?: string): string | Buffer;
}

export function createHash(algorithm: string): HashObject {
  const algo = algorithm.toLowerCase().replace('-', '');
  if (algo !== 'sha256' && algo !== 'sha1') {
    throw new Error(`Digest method not supported: ${algorithm} (only sha1 and sha256 are supported)`);
  }

  const chunks: Uint8Array[] = [];

  return {
    update(data: string | Uint8Array): ReturnType<typeof createHash> {
      if (typeof data === 'string') {
        chunks.push(new TextEncoder().encode(data));
      } else {
        chunks.push(data);
      }
      return this;
    },
    digest(encoding?: string): string | Buffer {
      let totalLen = 0;
      for (const c of chunks) totalLen += c.length;
      const merged = new Uint8Array(totalLen);
      let offset = 0;
      for (const c of chunks) {
        merged.set(c, offset);
        offset += c.length;
      }

      const result = algo === 'sha1' ? sha1sync(merged) : sha256sync(merged);

      if (encoding === 'hex') return toHex(result);
      if (encoding === 'base64') return Buffer.from(result).toString('base64');
      return Buffer.from(result);
    },
  };
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

function toHex(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += bytes[i].toString(16).padStart(2, '0');
  return s;
}

/** Node.js 21+ one-shot sync hash: crypto.hash(algo, data, encoding) */
export function hash(algorithm: string, data: string | Uint8Array, outputEncoding: string = 'hex'): string {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  const algo = algorithm.toLowerCase().replace('-', '');
  if (algo !== 'sha256') {
    throw new Error(`crypto.hash: only sha256 is supported in browser, got ${algorithm}`);
  }
  const digest = sha256sync(bytes);
  if (outputEncoding === 'hex') return toHex(digest);
  if (outputEncoding === 'base64') return Buffer.from(digest).toString('base64');
  return toHex(digest);
}

export default { randomBytes, randomUUID, createHash, randomInt, getRandomValues, subtle, hash };
