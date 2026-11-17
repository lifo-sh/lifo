import { describe, expect, it } from 'vitest';
import * as real from 'node:crypto';
import lifo, { createHmac, pbkdf2, pbkdf2Sync, timingSafeEqual } from '../../src/node-compat/crypto.js';

const rand = (n: number) => new Uint8Array(real.randomBytes(n));

describe('crypto.createHmac', () => {
	it('matches Node for every supported digest, short and long keys, in every encoding', () => {
		for (const algo of ['md5', 'sha1', 'sha256', 'sha512']) {
			for (const keyLen of [0, 5, 64, 129, 300]) {
				const key = rand(keyLen);
				const data = rand(1000);
				const want = real.createHmac(algo, key).update(data.subarray(0, 300)).update(data.subarray(300)).digest('hex');
				expect(createHmac(algo, key).update(data.subarray(0, 300)).update(data.subarray(300)).digest('hex')).toBe(want);
			}
		}
		expect(createHmac('sha256', 'key').update('text', 'utf8').digest('base64')).toBe(real.createHmac('sha256', 'key').update('text').digest('base64'));
		expect(createHmac('sha256', 'k').update('x').digest()).toBeInstanceOf(Uint8Array);
		expect(lifo.createHmac).toBe(createHmac);
	});
});

describe('crypto.pbkdf2Sync', () => {
	it('matches Node, including SCRAM-SHA-256 parameters and keys longer than one block', () => {
		const cases: [string, number, number, string][] = [
			['sha256', 4096, 32, 'sha256'],
			['sha1', 2, 20, 'sha1'],
			['sha512', 10, 100, 'sha512'],
			['sha256', 1, 70, 'sha256'],
		];
		for (const [, iterations, keylen, digest] of cases) {
			const password = 'pa ss wörd';
			const salt = rand(16);
			expect(pbkdf2Sync(password, salt, iterations, keylen, digest).toString('hex')).toBe(real.pbkdf2Sync(password, salt, iterations, keylen, digest).toString('hex'));
		}
	});

	it('pbkdf2 calls back with the same key', async () => {
		const key = await new Promise<Uint8Array>((resolve, reject) => pbkdf2('p', 's', 3, 16, 'sha256', (err, k) => (err ? reject(err) : resolve(k!))));
		expect(Buffer.from(key).toString('hex')).toBe(real.pbkdf2Sync('p', 's', 3, 16, 'sha256').toString('hex'));
	});
});

describe('crypto.timingSafeEqual', () => {
	it('compares equal-length buffers and refuses different lengths', () => {
		expect(timingSafeEqual(Buffer.from('abc'), Buffer.from('abc'))).toBe(true);
		expect(timingSafeEqual(Buffer.from('abc'), Buffer.from('abd'))).toBe(false);
		expect(() => timingSafeEqual(Buffer.from('a'), Buffer.from('ab'))).toThrow(RangeError);
	});
});
