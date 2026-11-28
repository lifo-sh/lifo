import { describe, expect, it } from 'vitest';
import { lockDownCredentials } from '../../src/sandbox/worker/host.js';
import { platformFetch } from '../../src/cloud/platform-fetch.js';

// lockDownCredentials changes this realm's globals for good, so it gets a test file of its own.
describe('lockDownCredentials', () => {
	it('strips credentials from fetch, XHR and EventSource, keeps Lifo\'s own requests on the safe fetch, and refuses WebSockets to the page\'s site', async () => {
		const seen: RequestInit[] = [];
		const g = globalThis as Record<string, unknown>;
		Object.defineProperty(globalThis, 'location', { value: { origin: 'https://lifo.example' }, configurable: true });
		g.fetch = async (_input: unknown, init?: RequestInit) => {
			seen.push(init ?? {});
			return new Response('ok');
		};
		// Like the real one: withCredentials is an accessor on the prototype.
		class FakeXHR {
			private wc = false;
			get withCredentials() {
				return this.wc;
			}
			set withCredentials(v: boolean) {
				this.wc = v;
			}
		}
		g.XMLHttpRequest = FakeXHR;
		class FakeES {
			constructor(
				public url: string,
				public init?: EventSourceInit,
			) {}
		}
		g.EventSource = FakeES;
		class FakeWS {
			constructor(public url: URL) {}
		}
		g.WebSocket = FakeWS;

		lockDownCredentials();

		await fetch('https://lifo.example/api/box-token', { method: 'POST', credentials: 'include' });
		expect(seen[0].credentials).toBe('omit');

		// A program may wrap the global, as in Node (Next.js does); Lifo's own requests (its
		// token-bearing Lifo Cloud calls) still go through the credential-free one, and the
		// global can't be deleted to uncover the realm's own fetch.
		const programSaw: unknown[] = [];
		(globalThis as { fetch: unknown }).fetch = (input: unknown) => { programSaw.push(input); return null; };
		await platformFetch('https://lifo.example/api/me', { credentials: 'include' });
		expect(programSaw).toEqual([]);
		expect(seen[1].credentials).toBe('omit');
		expect(() => { delete (globalThis as { fetch?: unknown }).fetch; }).toThrow();

		const xhr = new (g.XMLHttpRequest as typeof FakeXHR)();
		xhr.withCredentials = true;
		expect(xhr.withCredentials).toBe(false);

		const es = new (g.EventSource as typeof FakeES)('https://lifo.example/events', { withCredentials: true });
		expect(es.init?.withCredentials).toBe(false);

		const WS = g.WebSocket as new (url: string) => unknown;
		expect(() => new WS('wss://lifo.example/socket')).toThrow(/page's own site/);
		expect(() => new WS('/relative')).toThrow(/page's own site/);
		expect(new WS('wss://elsewhere.example/socket')).toBeTruthy();
	});
});
