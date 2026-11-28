// Lifo's event loop for hosts without Node's (a browser or Web Worker): timers and immediates in
// Node's phase order, and process.nextTick from a promise callback only once the microtask queue
// is empty. Loaded here with setImmediate hidden, so the module takes its browser path.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

type Loop = typeof import('../../src/node-compat/event-loop.js');
let loop: Loop;
const g = globalThis as { setImmediate?: unknown };
const saved = g.setImmediate;

beforeAll(async () => {
	vi.resetModules();
	delete g.setImmediate;
	loop = await import('../../src/node-compat/event-loop.js');
	g.setImmediate = saved;
});

afterAll(() => {
	g.setImmediate = saved;
});

const settle = (ms = 30) => new Promise((r) => setTimeout(r, ms));

describe('event loop (browser path)', () => {
	it('takes the browser path', () => {
		expect(loop.hostHasNodeLoop).toBe(false);
	});

	it('runs every due timer before an immediate one of them queued (Next.js atomic timer groups)', async () => {
		const order: string[] = [];
		const first = loop.addTimer(() => {
			order.push('timer 1');
			loop.addImmediate(() => order.push('immediate'));
		}, 0);
		const second = loop.addTimer(() => order.push('timer 2'), 0);
		loop.retime(second, first.start); // what Next.js does with _idleStart
		await settle();
		expect(order).toEqual(['timer 1', 'timer 2', 'immediate']);
	});

	it('drains microtasks between callbacks', async () => {
		const order: string[] = [];
		loop.addTimer(() => {
			order.push('t1');
			Promise.resolve().then(() => order.push('t1 microtask'));
		}, 0);
		loop.addTimer(() => order.push('t2'), 0);
		await settle();
		expect(order).toEqual(['t1', 't1 microtask', 't2']);
	});

	it('cancels timers and immediates', async () => {
		const order: string[] = [];
		const t = loop.addTimer(() => order.push('timer'), 0);
		const i = loop.addImmediate(() => order.push('immediate'));
		loop.cancel(t);
		loop.cancel(i);
		loop.addImmediate(() => order.push('kept'));
		await settle();
		expect(order).toEqual(['kept']);
	});

	it('a nextTick from a promise callback runs once the microtask queue is empty, before timers', async () => {
		const order: string[] = [];
		loop.addTimer(() => {
			order.push('timer 1');
			Promise.resolve().then(() => {
				loop.scheduleTick(() => order.push('tick'));
				let p = Promise.resolve();
				for (let i = 0; i < 5; i++) p = p.then(() => { order.push('chain ' + i); });
			});
		}, 0);
		loop.addTimer(() => order.push('timer 2'), 0);
		await settle();
		expect(order).toEqual(['timer 1', 'chain 0', 'chain 1', 'chain 2', 'chain 3', 'chain 4', 'tick', 'timer 2']);
	});

	it('a nextTick from a callback\'s synchronous part runs before its promise callbacks', async () => {
		const order: string[] = [];
		loop.addTimer(() => {
			loop.scheduleTick(() => order.push('tick'));
			Promise.resolve().then(() => order.push('promise'));
			order.push('sync');
		}, 0);
		await settle();
		expect(order).toEqual(['sync', 'tick', 'promise']);
	});

	it('waits for timers that are not due yet', async () => {
		const order: string[] = [];
		const start = Date.now();
		loop.addTimer(() => order.push(`late ${Date.now() - start >= 35}`), 40);
		loop.addTimer(() => order.push('soon'), 1);
		await settle(80);
		expect(order).toEqual(['soon', 'late true']);
	});
});
