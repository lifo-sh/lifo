import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import {
	DEFAULT_BASE_URL,
	createPkce,
	loadAuth,
	loginUrl,
	normalizeBaseUrl,
	removeSession,
	resolveBaseUrl,
	saveSession,
	type AuthStore,
} from '../../src/cloud/auth.js';
import { base64ToBytes, bytesToBase64 } from '../../src/cloud/tunnel-client.js';

function memoryStore(initial: string | null = null): AuthStore & { data: string | null } {
	return {
		data: initial,
		async read() {
			return this.data;
		},
		async write(d) {
			this.data = d;
		},
	};
}

describe('base URL', () => {
	it('prefers --base-url, then LIFO_BASE_URL, then the last login, then lifo.sh', () => {
		const file = { current: 'http://localhost:3000', sessions: {} };
		expect(resolveBaseUrl({ flag: 'https://a.test/', env: 'https://b.test', file })).toBe('https://a.test');
		expect(resolveBaseUrl({ env: 'https://b.test', file })).toBe('https://b.test');
		expect(resolveBaseUrl({ file })).toBe('http://localhost:3000');
		expect(resolveBaseUrl({})).toBe(DEFAULT_BASE_URL);
	});

	it('normalizes to an origin and rejects non-http URLs', () => {
		expect(normalizeBaseUrl('lifo.sh')).toBe('https://lifo.sh');
		expect(normalizeBaseUrl('http://localhost:3000/dashboard')).toBe('http://localhost:3000');
		expect(() => normalizeBaseUrl('ftp://x.test')).toThrow();
	});
});

describe('sessions', () => {
	it('keeps one session per website and makes the last login current', async () => {
		const store = memoryStore();
		await saveSession(store, 'https://lifo.sh', { token: 'lifo_a', email: 'a@x.test', savedAt: '' });
		await saveSession(store, 'http://localhost:3000', { token: 'lifo_b', email: 'b@x.test', savedAt: '' });
		let file = await loadAuth(store);
		expect(file.current).toBe('http://localhost:3000');
		expect(Object.keys(file.sessions)).toEqual(['https://lifo.sh', 'http://localhost:3000']);
		await removeSession(store, 'http://localhost:3000');
		file = await loadAuth(store);
		expect(file.sessions['http://localhost:3000']).toBeUndefined();
		expect(file.sessions['https://lifo.sh']?.token).toBe('lifo_a');
	});

	it('treats a missing or corrupt file as logged out', async () => {
		expect(await loadAuth(memoryStore())).toEqual({ sessions: {} });
		expect(await loadAuth(memoryStore('{not json'))).toEqual({ sessions: {} });
	});
});

describe('PKCE and login URL', () => {
	it('challenge is the base64url SHA-256 of the verifier', async () => {
		const { verifier, challenge, state } = await createPkce();
		expect(challenge).toBe(createHash('sha256').update(verifier).digest('base64url'));
		expect(challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
		expect(state.length).toBeGreaterThan(10);
	});

	it('includes the loopback port only when there is one', () => {
		const base = { challenge: 'c', state: 's', client: 'lifo-sh on mac' };
		expect(new URL(loginUrl('http://localhost:3000', { ...base, port: 5555 })).searchParams.get('port')).toBe('5555');
		expect(new URL(loginUrl('http://localhost:3000', base)).searchParams.has('port')).toBe(false);
	});
});

describe('tunnel framing', () => {
	it('base64 round-trips binary bodies larger than one chunk', () => {
		const bytes = new Uint8Array(100_000).map((_, i) => i % 256);
		expect(base64ToBytes(bytesToBase64(bytes))).toEqual(bytes);
	});
});
