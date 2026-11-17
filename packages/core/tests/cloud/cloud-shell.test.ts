import { describe, expect, it } from 'vitest';
import { LifoCloud, type WebSocketConstructor } from '../../src/cloud/cloud-client.js';

/** A fake WebSocket the test drives from the "server" side. */
class FakeSocket {
	static last: FakeSocket;
	readyState = 0;
	sent: string[] = [];
	closedWith: [number?, string?] | null = null;
	private listeners: Record<string, ((e: any) => void)[]> = {};
	constructor(
		readonly url: string,
		readonly protocols?: string | string[],
	) {
		FakeSocket.last = this;
	}
	addEventListener(type: string, cb: (e: any) => void) {
		(this.listeners[type] ??= []).push(cb);
	}
	send(data: string) {
		this.sent.push(data);
	}
	close(code?: number, reason?: string) {
		this.closedWith = [code, reason];
	}
	// server side
	open() {
		this.readyState = 1;
		for (const cb of this.listeners.open ?? []) cb({});
	}
	message(data: string) {
		for (const cb of this.listeners.message ?? []) cb({ data });
	}
	serverClose(code: number, reason = '') {
		this.readyState = 3;
		for (const cb of this.listeners.close ?? []) cb({ code, reason });
	}
}
const WS = FakeSocket as unknown as WebSocketConstructor;

describe('LifoCloud.shell', () => {
	const cloud = new LifoCloud({ token: 'lifo_abc', url: 'https://cloud.example.com/' });

	it('connects with the key as a subprotocol and the size in the URL', () => {
		void cloud.shell('my-api', { cols: 120, rows: 33, WebSocket: WS });
		expect(FakeSocket.last.url).toBe('wss://cloud.example.com/v1/boxes/my-api/shell?cols=120&rows=33');
		expect(FakeSocket.last.protocols).toEqual(['lifo-shell', 'lifo-token.lifo_abc']);
		expect(cloud.shellUrl('a b')).toBe('wss://cloud.example.com/v1/boxes/a%20b/shell?cols=80&rows=24');
		expect(new LifoCloud({ token: 't', url: 'http://localhost:4200' }).shellUrl('x')).toMatch(/^ws:\/\/localhost:4200\//);
	});

	it('resolves on the first frame, replays it, and speaks the JSON protocol', async () => {
		const p = cloud.shell('my-api', { WebSocket: WS });
		const sock = FakeSocket.last;
		sock.open();
		sock.message('Lifo Cloud · my-api\r\n');
		const sh = await p;
		const out: string[] = [];
		sh.onData((d) => out.push(d));
		sock.message('$ ');
		expect(out).toEqual(['Lifo Cloud · my-api\r\n', '$ ']);

		sh.write('ls\r');
		sh.resize(100.4, 40);
		expect(sock.sent.map((s) => JSON.parse(s))).toEqual([
			{ t: 'i', d: 'ls\r' },
			{ t: 'r', c: 100, r: 40 },
		]);

		const closes: [number, string][] = [];
		sh.onClose((c, r) => closes.push([c, r]));
		sock.serverClose(1000, 'exit');
		expect(closes).toEqual([[1000, 'exit']]);
		// A listener added after the end still hears about it.
		sh.onClose((c) => closes.push([c, 'late']));
		expect(closes[1]).toEqual([1000, 'late']);
	});

	it('rejects with the code and reason when the cloud refuses', async () => {
		const p = cloud.shell('theirs', { WebSocket: WS });
		FakeSocket.last.open();
		FakeSocket.last.serverClose(4403, `The box "theirs" isn't yours`);
		await expect(p).rejects.toMatchObject({ code: 4403, message: `The box "theirs" isn't yours` });
	});

	it('close() disconnects; nothing is sent once closed', async () => {
		const p = cloud.shell('my-api', { WebSocket: WS });
		const sock = FakeSocket.last;
		sock.open();
		sock.message('hi');
		const sh = await p;
		sh.close();
		expect(sock.closedWith).toEqual([1000, 'bye']);
		sock.readyState = 3;
		sh.write('x');
		expect(sock.sent).toEqual([]);
	});
});

describe('createShellEscape (~. disconnects, like ssh)', async () => {
	const { createShellEscape } = await import('../../src/cloud/shell-escape.js');
	it('disconnects on ~. at the start of a line only', () => {
		const e = createShellEscape();
		expect(e('ls ~/x\r')).toEqual({ send: 'ls ~/x\r', disconnect: false });
		expect(e('~')).toEqual({ send: '', disconnect: false });
		expect(e('.')).toEqual({ send: '', disconnect: true });
	});
	it('passes ~ through otherwise, and ~~ is one ~', () => {
		const e = createShellEscape();
		expect(e('~/a')).toEqual({ send: '~/a', disconnect: false });
		expect(e('\r~~')).toEqual({ send: '\r~', disconnect: false });
		expect(e('\r~.')).toEqual({ send: '\r', disconnect: true });
	});
});
