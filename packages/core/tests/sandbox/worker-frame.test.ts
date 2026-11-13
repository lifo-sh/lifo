import { describe, expect, it, afterEach } from 'vitest';
import { MessageChannel } from 'node:worker_threads';
import { WorkerSandbox } from '../../src/sandbox/worker/client.js';
import { openBoxFrame, serveBoxFrame, serveSandboxWhenConnected } from '../../src/sandbox/worker/frame.js';
import type { Endpoint } from '../../src/sandbox/worker/rpc.js';

// A box on another origin (frame.ts): the host page on the box origin answers only its allowed
// parent, starts the worker and hands over two ports; the worker serves the box on the port it's
// given. The browser pieces (iframe, window messages) are faked; the ports are real.

const g = globalThis as unknown as Record<string, unknown>;
const saved: Record<string, unknown> = {};
function setGlobal(name: string, value: unknown) {
	if (!(name in saved)) saved[name] = g[name];
	g[name] = value;
}
afterEach(() => {
	for (const [k, v] of Object.entries(saved)) {
		if (v === undefined) delete g[k];
		else g[k] = v;
		delete saved[k];
	}
});

describe('serveSandboxWhenConnected', () => {
	it('serves the box on the port the host page hands over, not on the worker global', async () => {
		const scope = new MessageChannel(); // the worker's global, as the host page sees it
		const box = new MessageChannel(); // the port that goes on to the site's page
		serveSandboxWhenConnected(scope.port1 as unknown as Endpoint, { lockDownCredentials: false, routeConsole: false });
		scope.port2.postMessage({ type: 'lifo-box-port' }, [box.port1]);
		const sandbox = await WorkerSandbox.create({ worker: box.port2 as unknown as Endpoint });
		const r = await sandbox.commands.run('echo on-the-port');
		expect(r.stdout.trim()).toBe('on-the-port');
		sandbox.destroy();
		setTimeout(() => [scope.port1, scope.port2, box.port1, box.port2].forEach((p) => p.close()), 300);
	});
});

describe('serveBoxFrame', () => {
	function fakeHostWindow() {
		const listeners: Array<(e: unknown) => void> = [];
		const toParent: Array<{ msg: unknown; target: unknown; transfer?: unknown[] }> = [];
		const parent = {
			postMessage(msg: unknown, target: unknown) {
				const opts = target as { targetOrigin?: string; transfer?: unknown[] };
				toParent.push(typeof target === 'string' ? { msg, target } : { msg, target: opts.targetOrigin, transfer: opts.transfer });
			},
		};
		setGlobal('window', { parent, addEventListener: (_t: string, l: (e: unknown) => void) => listeners.push(l) });
		const dispatch = (e: unknown) => listeners.forEach((l) => l(e));
		return { parent, toParent, dispatch };
	}

	it('says ready only to allowed origins, and answers only the parent page from an allowed origin, once', () => {
		const { parent, toParent, dispatch } = fakeHostWindow();
		const workers: Array<{ posted: unknown[] }> = [];
		serveBoxFrame({
			allowedOrigins: ['https://lifo.sh'],
			createWorker: () => {
				const w = { posted: [] as unknown[], postMessage(m: unknown) { w.posted.push(m); }, terminate() {} };
				workers.push(w);
				return w as unknown as Worker;
			},
		});
		expect(toParent).toEqual([{ msg: { type: 'lifo-box-host-ready' }, target: 'https://lifo.sh' }]);

		const connect = { type: 'lifo-box-connect', nonce: 'n1' };
		dispatch({ origin: 'https://evil.example', source: parent, data: connect }); // wrong origin
		dispatch({ origin: 'https://lifo.sh', source: { postMessage() {} }, data: connect }); // not the parent
		dispatch({ origin: 'https://lifo.sh', source: parent, data: { type: 'something-else' } });
		expect(workers).toHaveLength(0);

		dispatch({ origin: 'https://lifo.sh', source: parent, data: connect });
		expect(workers).toHaveLength(1);
		const reply = toParent.at(-1)!;
		expect(reply.msg).toEqual({ type: 'lifo-box-port', nonce: 'n1' });
		expect(reply.target).toBe('https://lifo.sh');
		expect(reply.transfer).toHaveLength(2); // the box's port and the control port

		dispatch({ origin: 'https://lifo.sh', source: parent, data: { type: 'lifo-box-connect', nonce: 'n2' } });
		expect(workers).toHaveLength(1); // one box per host page
		for (const p of reply.transfer as Array<{ close(): void }>) p.close();
	});

	it('does nothing when the host page is not framed', () => {
		const self = { addEventListener() { throw new Error('should not listen'); } } as Record<string, unknown>;
		self.parent = self;
		setGlobal('window', self);
		expect(() => serveBoxFrame({ allowedOrigins: ['https://lifo.sh'], createWorker: () => { throw new Error('no'); } })).not.toThrow();
	});
});

describe('openBoxFrame', () => {
	it("refuses a box origin that is the page's own origin", async () => {
		setGlobal('location', { origin: 'https://lifo.sh' });
		await expect(openBoxFrame({ origin: 'https://lifo.sh/' })).rejects.toThrow(/must be different/);
	});
});
