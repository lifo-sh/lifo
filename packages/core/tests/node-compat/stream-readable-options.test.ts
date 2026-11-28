// new Readable({ read, destroy }): Node's simplified construction (Next.js replays React's
// flight data through one).
import { describe, it, expect } from 'vitest';
import { Readable } from '../../src/node-compat/stream.js';
import { Buffer as LifoBuffer } from '../../src/node-compat/buffer.js';

describe('Readable options', () => {
	it('pulls from read() and calls destroy()', async () => {
		const chunks = ['a', 'b'];
		const r = new Readable({
			read() {
				const next = chunks.shift();
				this.push(next === undefined ? null : Buffer.from(next));
			},
		});
		const seen: string[] = [];
		await new Promise<void>((done) => {
			r.on('data', (c) => seen.push(String(c)));
			r.on('end', () => done());
		});
		expect(seen).toEqual(['a', 'b']);

		let destroyedWith: unknown = 'not called';
		const d = new Readable({ read() {}, destroy(err, cb) { destroyedWith = err; cb(err); } });
		const closed = new Promise<void>((done) => d.on('close', () => done()));
		d.destroy();
		await closed;
		expect(destroyedWith).toBeNull();
	});
});

describe('Readable async iteration', () => {
	it('yields chunks until end, rejects on error, and destroys on early exit', async () => {
		const r = new Readable({ read() {} });
		setTimeout(() => { r.push(Buffer.from('a')); r.push(Buffer.from('b')); r.push(null); }, 5);
		const got: string[] = [];
		for await (const chunk of r) got.push(String(chunk));
		expect(got).toEqual(['a', 'b']);

		const bad = new Readable({ read() {} });
		setTimeout(() => bad.destroy(new Error('boom')), 5);
		await expect((async () => { for await (const _ of bad) { /* nothing */ } })()).rejects.toThrow('boom');

		const early = new Readable({ read() { this.push(Buffer.from('x')); } });
		for await (const _ of early) break;
		expect(early.destroyed).toBe(true);
	});
});

describe('Readable paused mode (read() and readable), compared with Node', async () => {
	const nodeStream = await import('node:stream');
	// Next.js's pullFlightData: read() until null, then wait for 'readable' or 'end'.
	async function pull(r: { read(): unknown; readableEnded: boolean; readableLength: number; on(e: string, f: (...a: unknown[]) => void): unknown; removeListener(e: string, f: (...a: unknown[]) => void): unknown }) {
		const out: string[] = [];
		for (;;) {
			const chunk = r.read();
			if (chunk !== null) { out.push(String(chunk)); continue; }
			if (r.readableEnded) return out;
			await (r.readableLength > 0 || r.readableEnded ? Promise.resolve() : new Promise<void>((resolve) => {
				const done = () => { r.removeListener('readable', done); r.removeListener('end', done); resolve(); };
				r.on('readable', done);
				r.on('end', done);
			}));
		}
	}
	const make = (Ctor: new (o: object) => never, mode: 'sync' | 'later') => {
		const chunks = ['a', 'b', 'c'];
		return new Ctor({
			read(this: { push(c: unknown): void }) {
				const go = () => { const n = chunks.shift(); this.push(n === undefined ? null : Buffer.from(n)); };
				if (mode === 'sync') go(); else setTimeout(go, 2);
			},
		});
	};
	for (const mode of ['sync', 'later'] as const) {
		it(`pulls every chunk then ends (${mode} read)`, async () => {
			const lifo = await pull(make(Readable as never, mode));
			const node = await pull(make(nodeStream.Readable as never, mode));
			expect(lifo.join('')).toBe(node.join(''));
			expect(lifo.join('')).toBe('abc');
		});
	}
	it('reports length and ended state', async () => {
		const r = new Readable({ read() {} });
		r.push(Buffer.from('xy'));
		expect(r.readableLength).toBe(2);
		expect(String(r.read())).toBe('xy');
		r.push(null);
		expect(r.read()).toBeNull();
		await new Promise((done) => setTimeout(done, 1));
		expect(r.readableEnded).toBe(true);
	});
});

describe('Readable byte chunks', () => {
	it('hands out a pushed Uint8Array as a Buffer, as Node does', () => {
		const r = new Readable({ read() {} });
		r.push(new TextEncoder().encode('{"a":1}'));
		const chunk = r.read() as InstanceType<typeof LifoBuffer>;
		expect(LifoBuffer.isBuffer(chunk)).toBe(true);
		expect(chunk.toString('utf-8')).toBe('{"a":1}');
	});
});
