import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Extract the WS_SHIM source string from sw.js and evaluate it against mocked
 * browser globals. The shim can't run in a real service worker headlessly, so
 * this exercises its decision logic (which URLs to proxy) and message wiring —
 * the parts a MessageChannel-only bridge test can't reach.
 */
const swSource = readFileSync(fileURLToPath(new URL('../public/sw.js', import.meta.url)), 'utf8');
const shimMatch = swSource.match(/const WS_SHIM = `([\s\S]*?)`;/);
const WS_SHIM = shimMatch![1];

interface MockControllerMessage { type: string; connId?: string; [k: string]: unknown }

function installShim(controllerPresent = true) {
	const posted: MockControllerMessage[] = [];
	const swListeners: Array<(e: { data: unknown }) => void> = [];
	const controller = controllerPresent ? { postMessage: (m: MockControllerMessage) => posted.push(m) } : null;

	const sandbox = {
		navigator: {
			serviceWorker: {
				controller,
				addEventListener: (type: string, fn: (e: { data: unknown }) => void) => {
					if (type === 'message') swListeners.push(fn);
				},
			},
		},
		location: { href: 'http://localhost:5173/_sw/5173/', host: 'localhost:5173', origin: 'http://localhost:5173' },
		window: {} as Record<string, unknown>,
		URL,
		Map,
		Math,
		TextEncoder,
		TextDecoder,
		btoa,
		atob,
		MessageEvent: globalThis.MessageEvent ?? class { type: string; data: unknown; constructor(t: string, i: { data: unknown }) { this.type = t; this.data = i.data; } },
		Event: globalThis.Event ?? class { type: string; constructor(t: string) { this.type = t; } },
		CloseEvent: (globalThis as { CloseEvent?: unknown }).CloseEvent ?? class { type: string; code: number; reason: string; constructor(t: string, i: { code: number; reason: string }) { this.type = t; this.code = i.code; this.reason = i.reason; } },
		Blob: globalThis.Blob ?? class { constructor(public parts: unknown[]) {} },
		ArrayBuffer,
		Uint8Array,
		OrigWS: class NativeWS { constructor(public url: string, public protocols?: unknown) {} },
	};

	// The shim captures `var OrigWS = window.WebSocket` — seed the native impl.
	sandbox.window.WebSocket = sandbox.OrigWS;

	// eslint-disable-next-line @typescript-eslint/no-implied-eval
	new Function('navigator', 'location', 'window', 'URL', 'Map', 'Math', 'TextEncoder', 'TextDecoder', 'btoa', 'atob', 'MessageEvent', 'Event', 'CloseEvent', 'Blob', 'ArrayBuffer', 'Uint8Array',
		`${WS_SHIM}`,
	)(sandbox.navigator, sandbox.location, sandbox.window, sandbox.URL, sandbox.Map, sandbox.Math, sandbox.TextEncoder, sandbox.TextDecoder, sandbox.btoa, sandbox.atob, sandbox.MessageEvent, sandbox.Event, sandbox.CloseEvent, sandbox.Blob, sandbox.ArrayBuffer, sandbox.Uint8Array);

	return {
		WebSocket: sandbox.window.WebSocket as new (url: string, protocols?: unknown) => Record<string, unknown>,
		posted,
		deliverFromSw: (data: unknown) => swListeners.forEach((fn) => fn({ data })),
		OrigWS: sandbox.OrigWS,
	};
}

describe('ws-shim (service worker WebSocket replacement)', () => {
	let env: ReturnType<typeof installShim>;
	beforeEach(() => { env = installShim(); });

	it('proxies same-host ws:// URLs (the Vite HMR socket) — not treated as cross-origin', () => {
		const ws = new env.WebSocket('ws://localhost:5173/?token=abc', 'vite-hmr') as Record<string, unknown> & { connId: string };
		// Must NOT be the native fallback
		expect(ws instanceof (env.OrigWS as never)).toBe(false);
		const open = env.posted.find((m) => m.type === 'ws-open');
		expect(open).toBeTruthy();
		expect(open!.url).toBe('/?token=abc');
		expect(open!.protocol).toBe('vite-hmr');
	});

	it('leaves cross-host WebSockets on the native implementation', () => {
		const ws = new env.WebSocket('wss://example.com/socket');
		expect(ws instanceof (env.OrigWS as never)).toBe(true);
		expect(env.posted.find((m) => m.type === 'ws-open')).toBeUndefined();
	});

	it('fires onopen when the SW reports ws-opened', () => {
		const ws = new env.WebSocket('ws://localhost:5173/') as Record<string, unknown> & { connId: string; readyState: number };
		let opened = false;
		(ws as { onopen: () => void }).onopen = () => { opened = true; };
		env.deliverFromSw({ type: 'ws-opened', connId: ws.connId });
		expect(opened).toBe(true);
		expect(ws.readyState).toBe(1);
	});

	it('delivers text ws-message payloads to onmessage', () => {
		const ws = new env.WebSocket('ws://localhost:5173/') as Record<string, unknown> & { connId: string };
		let received: string | null = null;
		(ws as { onmessage: (e: { data: string }) => void }).onmessage = (e) => { received = e.data; };
		const payload = btoa(new TextDecoder().decode(new TextEncoder().encode(JSON.stringify({ type: 'update' }))));
		env.deliverFromSw({ type: 'ws-message', connId: ws.connId, data: payload, binary: false });
		expect(received).toBe(JSON.stringify({ type: 'update' }));
	});

	it('send() posts a base64 ws-send with the connId', () => {
		const ws = new env.WebSocket('ws://localhost:5173/') as Record<string, unknown> & { connId: string; send: (d: string) => void };
		ws.send(JSON.stringify({ type: 'ping' }));
		const sent = env.posted.find((m) => m.type === 'ws-send');
		expect(sent).toBeTruthy();
		expect(sent!.connId).toBe(ws.connId);
		expect(atob(sent!.data as string)).toBe(JSON.stringify({ type: 'ping' }));
	});

	it('falls back to native when no SW controller is present', () => {
		const noCtrl = installShim(false);
		// Shim bails early → window.WebSocket left as the native constructor
		expect(noCtrl.WebSocket).toBe(noCtrl.OrigWS);
	});
});
