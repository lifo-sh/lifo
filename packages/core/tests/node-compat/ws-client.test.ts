import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import path from 'node:path';
import { Sandbox } from '../../src/sandbox/Sandbox.js';
import { encodeServerFrame } from '../../src/node-compat/ws-client.js';
import { FrameDecoder, OPCODE } from '../../src/kernel/network/ws-frame.js';

// The real `ws` package, mounted into each box: the client library playwright-core and
// puppeteer bundle, so this is what has to work.
const require = createRequire(import.meta.url);
const WS_DIR = path.dirname(require.resolve('ws/package.json'));
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { WebSocketServer } = require('ws') as typeof import('ws');

async function box() {
	return Sandbox.create({ mounts: [{ virtualPath: '/home/user/node_modules/ws', hostPath: WS_DIR, readOnly: true }] });
}

async function run(b: Sandbox, js: string) {
	await b.fs.writeFile('/home/user/t.cjs', js);
	const r = await b.commands.run('node t.cjs', { timeout: 15_000 });
	return { ...r, out: r.stdout.trim() };
}

describe('server frames', () => {
	it('encodes short, 16-bit and 64-bit lengths unmasked', () => {
		for (const n of [5, 300, 70_000]) {
			const payload = new Uint8Array(n).fill(7);
			const [f] = new FrameDecoder().push(encodeServerFrame(OPCODE.binary, payload));
			expect(f.opcode).toBe(OPCODE.binary);
			expect(f.fin).toBe(true);
			expect(f.payload.length).toBe(n);
		}
	});
});

describe('WebSocket clients in a box (http.request upgrade)', { timeout: 20_000 }, () => {
	it('connects ws to a ws server in the same box', async () => {
		const b = await box();
		const r = await run(b, `
const { WebSocketServer, WebSocket } = require('ws');
const http = require('http');
const server = http.createServer();
const wss = new WebSocketServer({ server });
wss.on('connection', (s, req) => s.on('message', (m, bin) => s.send(bin ? m : 'echo:' + m, { binary: bin })));
server.listen(8090, () => {
  const c = new WebSocket('ws://localhost:8090/path');
  c.on('open', () => { c.send('hi'); c.send(Buffer.alloc(70000, 3)); });
  const got = [];
  c.on('message', (m, bin) => {
    got.push(bin ? 'bin:' + m.length : String(m));
    if (got.length === 2) { console.log(got.join(',')); c.close(4001, 'done'); }
  });
  c.on('close', (code) => { console.log('closed ' + code); server.close(); });
  c.on('error', (e) => console.log('error ' + e.message));
});
`);
		expect(r.out).toBe('echo:hi,bin:70000\nclosed 4001');
		b.destroy();
	});

	it('refuses localhost ports with nothing listening (never the host\'s loopback)', async () => {
		const b = await box();
		const r = await run(b, `
const { WebSocket } = require('ws');
const c = new WebSocket('ws://127.0.0.1:8999/');
c.on('error', (e) => console.log('error ' + (e.code || e.message)));
c.on('open', () => console.log('open?!'));
`);
		expect(r.out).toBe('error ECONNREFUSED');
		b.destroy();
	});

	describe('to a server outside the box, through the host WebSocket', () => {
		let wss: InstanceType<typeof WebSocketServer>;
		let port = 0;
		let realWS: unknown;
		beforeAll(async () => {
			wss = new WebSocketServer({ port: 0, handleProtocols: (p: Set<string>) => (p.has('cdp') ? 'cdp' : false) });
			await new Promise((r) => wss.once('listening', r));
			port = (wss.address() as { port: number }).port;
			wss.on('connection', (s, req) => {
				s.send(`hello ${req.url}`);
				s.on('message', (m, bin) => {
					if (!bin && String(m) === 'bye') return s.close(4002, 'server says bye');
					s.send(m, { binary: bin });
				});
			});
			// The box's "outside world": example.test maps to the local server (boxes can't
			// reach the host's loopback by name), through Node's own WebSocket.
			realWS = globalThis.WebSocket;
			const Real = globalThis.WebSocket;
			globalThis.WebSocket = class extends Real {
				constructor(url: string | URL, protocols?: unknown) {
					const u = new URL(String(url));
					if (u.hostname === 'example.test') {
						u.hostname = '127.0.0.1';
						u.port = String(port);
					}
					super(u.toString(), protocols as string[]);
				}
			} as typeof WebSocket;
		});
		afterAll(() => {
			globalThis.WebSocket = realWS as typeof WebSocket;
			wss.close();
		});

		it('handshakes (accept key, sub-protocol), echoes text and binary, closes from either side', async () => {
			const b = await box();
			const r = await run(b, `
const { WebSocket } = require('ws');
const c = new WebSocket('ws://example.test/devtools/browser', ['cdp']);
const got = [];
c.on('open', () => got.push('open:' + c.protocol));
c.on('message', (m, bin) => {
  got.push(bin ? 'bin:' + m.length : String(m));
  if (String(m).startsWith('hello')) { c.send('ping-text'); c.send(Buffer.alloc(70000, 1)); }
  else if (bin) c.send('bye');
});
c.on('close', (code, reason) => { got.push('close:' + code + ':' + reason); console.log(got.join('|')); });
c.on('error', (e) => console.log('error ' + e.message));
`);
			expect(r.out).toBe('open:cdp|hello /devtools/browser|ping-text|bin:70000|close:4002:server says bye');
			b.destroy();
		});

		it('a client-side close reaches the server', async () => {
			const b = await box();
			const closed = new Promise<number>((resolve) => wss.once('connection', (s) => s.once('close', (code: number) => resolve(code))));
			const r = await run(b, `
const { WebSocket } = require('ws');
const c = new WebSocket('ws://example.test/x');
c.on('message', () => c.close(4003, 'client done'));
c.on('close', (code) => console.log('closed ' + code));
`);
			expect(r.out).toBe('closed 4003');
			expect(await closed).toBe(4003);
			b.destroy();
		});
	});
});

describe('fs.mkdtemp', () => {
	it('makes a fresh directory, sync, callback and promise', async () => {
		const b = await Sandbox.create();
		const r = await run(b, `
const fs = require('fs');
const a = fs.mkdtempSync('/tmp/pw-');
const c = fs.mkdtempSync('/tmp/pw-');
fs.mkdtemp('/tmp/cb-', (err, d) => {
  fs.promises.mkdtemp('/tmp/pr-').then((p) => {
    console.log([a, c, d, p].every((x) => fs.statSync(x).isDirectory()), a !== c, /^\\/tmp\\/pw-[A-Za-z0-9]{6}$/.test(a), d.startsWith('/tmp/cb-'), p.startsWith('/tmp/pr-'));
  });
});
`);
		expect(r.out).toBe('true true true true true');
		b.destroy();
	});
});
