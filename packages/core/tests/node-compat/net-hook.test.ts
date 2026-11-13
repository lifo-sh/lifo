import { describe, expect, it } from 'vitest';
import { Sandbox } from '../../src/sandbox/Sandbox.js';
import type { BoxNet, BoxSocket, BoxNetConnectOptions } from '../../src/node-compat/net.js';

/** A host connector whose peers echo what they're sent, upper-cased once the link is TLS. */
function fakeNet(log: string[]): BoxNet {
	const make = (opts: BoxNetConnectOptions, secure: boolean): BoxSocket => {
		let onData: (b: Uint8Array) => void = () => {};
		let onClose: (e?: Error) => void = () => {};
		const refused = opts.host === '127.0.0.1' || opts.host === 'localhost';
		return {
			opened: refused ? Promise.reject(new Error('connect() to a private address is not allowed')) : Promise.resolve(),
			onData: (cb) => (onData = cb),
			onClose: (cb) => (onClose = cb),
			async write(bytes) {
				const text = new TextDecoder().decode(bytes);
				log.push(`${secure ? 'tls' : 'tcp'}:${opts.host}:${opts.port}:${text}`);
				queueMicrotask(() => onData(new TextEncoder().encode(secure ? text.toUpperCase() : text)));
			},
			end: () => queueMicrotask(() => onClose()),
			destroy: () => {},
			startTls: (o) => {
				log.push(`starttls:${o.servername}`);
				return make(opts, true);
			},
		};
	};
	return {
		connect(opts) {
			log.push(`connect:${opts.host}:${opts.port}${opts.tls ? ':tls' : ''}`);
			return make(opts, !!opts.tls);
		},
	};
}

async function run(box: Sandbox, js: string) {
	await box.fs.writeFile('/home/user/t.js', js);
	return box.commands.run('node t.js', { timeout: 10_000 });
}

describe('net and tls with a host connector', () => {
	it('net.connect sends and receives bytes, and reports close', async () => {
		const log: string[] = [];
		const box = await Sandbox.create({ net: fakeNet(log) });
		const r = await run(box, `
			const net = require('net');
			const s = net.connect(5432, 'db.example.com', () => { console.log('connected', s.remoteAddress, s.remotePort); s.write('ping'); });
			s.on('data', (d) => { console.log('data', Buffer.isBuffer(d), d.toString()); s.end(); });
			s.on('close', () => console.log('closed', s.bytesRead, s.bytesWritten));
		`);
		expect(r.stdout).toBe('connected db.example.com 5432\ndata true ping\nclosed 4 4\n');
		expect(log).toEqual(['connect:db.example.com:5432', 'tcp:db.example.com:5432:ping']);
		box.destroy();
	});

	it('new net.Socket().connect({ host, port }) works, and writes before connect are kept', async () => {
		const box = await Sandbox.create({ net: fakeNet([]) });
		const r = await run(box, `
			const { Socket } = require('net');
			const s = new Socket();
			s.setNoDelay(true); s.setKeepAlive(true);
			s.connect({ host: 'redis.example.com', port: 6379 });
			s.write('early');
			s.once('data', (d) => { console.log(String(d)); s.destroy(); });
		`);
		expect(r.stdout).toBe('early\n');
		box.destroy();
	});

	it('tls.connect is encrypted from the start; tls.connect({ socket }) upgrades a plain one', async () => {
		const log: string[] = [];
		const box = await Sandbox.create({ net: fakeNet(log) });
		const r = await run(box, `
			const net = require('net'), tls = require('tls');
			const t = tls.connect({ host: 'api.example.com', port: 443 }, () => { console.log('secure', t.encrypted); t.write('a'); });
			t.once('data', (d) => {
				console.log(String(d));
				const plain = net.connect(5432, 'pg.example.com', () => plain.write('sslrequest'));
				plain.once('data', () => {
					const up = tls.connect({ socket: plain, servername: 'pg.example.com' });
					up.on('secureConnect', () => up.write('query'));
					up.once('data', (x) => { console.log(String(x)); up.end(); t.end(); });
				});
			});
		`);
		expect(r.stdout).toBe('secure true\nA\nQUERY\n');
		expect(log).toContain('connect:api.example.com:443:tls');
		expect(log).toContain('starttls:pg.example.com');
		box.destroy();
	});

	it('an open socket keeps the program running, with no timer to hold it; unref lets it end', async () => {
		const log: string[] = [];
		const slow: BoxNet = {
			connect(opts) {
				const inner = fakeNet(log).connect(opts);
				// The peer answers 150 ms later, long after the script's last statement ran.
				return { ...inner, write: async (b) => void setTimeout(() => inner.write(b), 150) };
			},
		};
		const box = await Sandbox.create({ net: slow });
		const r = await run(box, `
			const net = require('net');
			const first = net.connect(80, 'a.example.com', () => first.write('one'));
			first.on('data', (d) => {
				console.log(String(d));
				first.end();
				const second = net.connect(80, 'b.example.com', () => second.write('two'));
				second.on('data', (x) => { console.log(String(x)); second.end(); });
			});
		`);
		expect(r.stdout).toBe('one\ntwo\n');
		const quiet = await run(box, `
			const s = require('net').connect(80, 'c.example.com', () => s.write('never printed'));
			s.unref();
			s.on('data', (d) => console.log(String(d)));
		`);
		expect(quiet.stdout).toBe('');
		box.destroy();
	});

	it('a refused connection is an error event with a code, not a hang', async () => {
		const box = await Sandbox.create({ net: fakeNet([]) });
		const r = await run(box, `
			const s = require('net').connect(5432, '127.0.0.1');
			s.on('error', (e) => console.log(e.code, e.address, e.port));
			s.on('close', (hadError) => console.log('closed', hadError));
		`);
		expect(r.stdout).toBe('ECONNREFUSED 127.0.0.1 5432\nclosed true\n');
		box.destroy();
	});

	it('without a connector net stays the in-tab stub', async () => {
		const box = await Sandbox.create();
		const r = await run(box, `
			const s = require('net').connect(5432, 'db.example.com', () => console.log('stub connected', typeof s.write));
		`);
		expect(r.stdout).toBe('stub connected function\n');
		box.destroy();
	});
});
