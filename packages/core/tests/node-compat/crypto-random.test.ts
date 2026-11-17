import { describe, expect, it } from 'vitest';
import nodeCrypto, { randomBytes, randomFill, randomFillSync } from '../../src/node-compat/crypto.js';
import { Sandbox } from '../../src/sandbox/Sandbox.js';

const nonZero = (b: Uint8Array) => b.some((x) => x !== 0);

describe('crypto random fills', () => {
  it('randomFillSync fills a whole view and returns it', () => {
    const buf = new Uint8Array(1024);
    expect(randomFillSync(buf)).toBe(buf);
    expect(nonZero(buf)).toBe(true);
  });

  it('fills more than Web Crypto allows in one call (65536 bytes)', () => {
    const big = randomFillSync(new Uint8Array(200_000));
    expect(nonZero(big.subarray(0, 65536))).toBe(true);
    expect(nonZero(big.subarray(131072))).toBe(true);
    expect(nonZero(randomBytes(100_000).subarray(70_000))).toBe(true);
  });

  it('honours offset and size, in elements for typed arrays', () => {
    const bytes = new Uint8Array(64);
    randomFillSync(bytes, 16, 32);
    expect(nonZero(bytes.subarray(0, 16))).toBe(false);
    expect(nonZero(bytes.subarray(48))).toBe(false);
    expect(nonZero(bytes.subarray(16, 48))).toBe(true);
    const words = new Uint32Array(8);
    randomFillSync(words, 4);
    expect(Array.from(words.subarray(0, 4))).toEqual([0, 0, 0, 0]);
    expect(() => randomFillSync(new Uint8Array(4), 2, 8)).toThrow(RangeError);
  });

  it('takes an ArrayBuffer and a view into a larger buffer (a wasm heap subarray)', () => {
    const heap = new Uint8Array(4096);
    randomFillSync(heap.subarray(1024, 1056));
    expect(nonZero(heap.subarray(0, 1024))).toBe(false);
    expect(nonZero(heap.subarray(1024, 1056))).toBe(true);
    expect(nonZero(heap.subarray(1056))).toBe(false);
    expect(nonZero(new Uint8Array(randomFillSync(new ArrayBuffer(32))))).toBe(true);
  });

  it('randomFill calls back', async () => {
    const buf = await new Promise<Uint8Array>((res, rej) => randomFill(new Uint8Array(32), (e, b) => (e ? rej(e) : res(b))));
    expect(nonZero(buf)).toBe(true);
    expect(typeof nodeCrypto.randomFillSync).toBe('function');
  });

  it('is there for programs in a box: require("node:crypto").randomFillSync', async () => {
    const box = await Sandbox.create();
    const r = await box.commands.run(`node -e "const b = require('node:crypto').randomFillSync(new Uint8Array(16)); console.log(b.length, b.some(x => x))"`);
    expect(r.stdout.trim()).toBe('16 true');
    box.destroy();
  });
});
