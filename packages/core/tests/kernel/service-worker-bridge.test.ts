import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ServiceWorkerBridge } from '../../src/kernel/network/ServiceWorkerBridge.js';
import type { VirtualRequestHandler } from '../../src/kernel/index.js';
import type { VirtualResponseWithDone } from '../../src/node-compat/http.js';

/** Decode a response body — bodyBuffer (transferred ArrayBuffer) or legacy base64. */
function bodyText(res: { bodyBuffer?: ArrayBuffer; body?: string }): string {
	if (res.bodyBuffer) return new TextDecoder().decode(new Uint8Array(res.bodyBuffer));
	return res.body ? new TextDecoder().decode(Uint8Array.from(atob(res.body), (c) => c.charCodeAt(0))) : '';
}

describe('ServiceWorkerBridge', () => {
	let portRegistry: Map<number, VirtualRequestHandler>;
	let bridge: ServiceWorkerBridge;
	let channel: MessageChannel;
	/** Plays the service worker: send a request message, await the response. */
	let swRequest: (msg: Record<string, unknown>) => Promise<{ requestId: string; statusCode: number; headers: Record<string, string>; body?: string; bodyBuffer?: ArrayBuffer }>;

	beforeEach(() => {
		portRegistry = new Map();
		bridge = new ServiceWorkerBridge(portRegistry);
		channel = new MessageChannel();
		bridge.attach(channel.port1 as unknown as MessagePort);
		swRequest = (msg) =>
			new Promise((resolve) => {
				const onMessage = (event: MessageEvent) => {
					if (event.data?.requestId === msg.requestId) {
						channel.port2.removeEventListener('message', onMessage as EventListener);
						resolve(event.data);
					}
				};
				channel.port2.addEventListener('message', onMessage as EventListener);
				channel.port2.start?.();
				channel.port2.postMessage(msg);
			});
	});

	afterEach(() => {
		bridge.detach();
		channel.port2.close();
	});

	it('answers a request from the port registry', async () => {
		portRegistry.set(8080, (vReq, vRes) => {
			vRes.statusCode = 200;
			vRes.headers = { 'content-type': 'text/plain' };
			vRes.body = `hello ${vReq.method} ${vReq.url}`;
		});
		const res = await swRequest({ type: 'request', requestId: 'r1', port: 8080, method: 'GET', url: '/greet', headers: {}, body: '' });
		expect(res.statusCode).toBe(200);
		expect(res.headers['content-type']).toBe('text/plain');
		expect(bodyText(res)).toBe('hello GET /greet');
	});

	it('awaits async handlers via _donePromise', async () => {
		portRegistry.set(8080, (vReq, vRes) => {
			(vRes as VirtualResponseWithDone)._donePromise = new Promise((resolve) => {
				setTimeout(() => {
					vRes.statusCode = 201;
					vRes.body = 'async done';
					resolve();
				}, 50);
			});
		});
		const res = await swRequest({ type: 'request', requestId: 'r2', port: 8080, method: 'GET', url: '/', headers: {}, body: '' });
		expect(res.statusCode).toBe(201);
		expect(bodyText(res)).toBe('async done');
	});

	it('decodes base64 request bodies for the handler', async () => {
		let seenBody = '';
		portRegistry.set(9000, (vReq, vRes) => {
			seenBody = vReq.body;
			vRes.body = 'ok';
		});
		const body = btoa('payload=42');
		const res = await swRequest({ type: 'request', requestId: 'r3', port: 9000, method: 'POST', url: '/submit', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body });
		expect(res.statusCode).toBe(200);
		expect(seenBody).toBe('payload=42');
	});

	it('404s for unregistered ports', async () => {
		const res = await swRequest({ type: 'request', requestId: 'r4', port: 5555, method: 'GET', url: '/', headers: {}, body: '' });
		expect(res.statusCode).toBe(404);
		expect(bodyText(res)).toContain('No server listening on port 5555');
	});

	it('500s when the handler throws', async () => {
		portRegistry.set(8081, () => {
			throw new Error('kaboom');
		});
		const res = await swRequest({ type: 'request', requestId: 'r5', port: 8081, method: 'GET', url: '/', headers: {}, body: '' });
		expect(res.statusCode).toBe(500);
		expect(bodyText(res)).toContain('kaboom');
	});
});
