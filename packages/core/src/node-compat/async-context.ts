/**
 * The async context AsyncLocalStorage reads, carried across async work the way Node carries it.
 *
 * A browser has no native async context, so Lifo carries one itself: the stores active now
 * (a "frame") travel with the work that continues later.
 *
 * - `await`: modules the node runner loads have each `await X` rewritten to
 *   `__lifoAsync.r(__lifoAsync.s(), await X)` (await-context.ts), which captures the frame
 *   before the await and restores it after.
 * - Promise callbacks: `.then`/`.catch`/`.finally` run in the frame they were registered in.
 * - Timers, immediates, process.nextTick and queueMicrotask: their callbacks run in the frame
 *   they were scheduled in.
 *
 * Nothing is wrapped until the first AsyncLocalStorage.run()/enterWith(), so programs that
 * never use it pay nothing. React Server Components and Next.js depend on it: the request's
 * stores (workStore, ...) must survive every await while a page renders.
 *
 * Not carried: async generators across `yield`, `for await` loop bodies, and code a module
 * builds at run time for eval / new Function (an eval of a string literal is rewritten too:
 * webpack's eval-source-map modules).
 */

import { addImmediate, cancel, type LoopTask } from './event-loop.js';
import { instrumentAwaits } from './await-context.js';

/** The stores active now, by AsyncLocalStorage; replaced (never mutated) on every change. */
export type Frame = ReadonlyMap<object, unknown> | undefined;

/**
 * Shared through globalThis, so rewritten code and every copy of this module in the realm see
 * one frame: `s()` captures it before an await, `r(frame, value)` restores it after.
 */
interface AsyncState {
	current: Frame;
	active: boolean;
	s(): Frame;
	r<T>(frame: Frame, value: T): T;
}
const g = globalThis as unknown as { __lifoAsync?: AsyncState } & Record<string, unknown>;
const state: AsyncState = (g.__lifoAsync ??= {
	current: undefined,
	active: false,
	s() { return this.current; },
	r(frame, value) { this.current = frame; return value; },
});
// Bound, so they work taken off the object too.
state.s = state.s.bind(state);
state.r = state.r.bind(state);

export function currentFrame(): Frame {
	return state.current;
}

export function setFrame(frame: Frame): void {
	state.current = frame;
}

/** Run `fn` in `frame`, then put back the frame that was active. */
export function runInFrame<R>(frame: Frame, fn: (...args: never[]) => R, thisArg?: unknown, args: unknown[] = []): R {
	const prev = state.current;
	state.current = frame;
	try {
		return (fn as (...a: unknown[]) => R).apply(thisArg, args);
	} finally {
		state.current = prev;
	}
}

/** `fn` bound to the frame active now: it runs there whenever it's called. */
export function bindToFrame<F>(fn: F): F {
	if (!state.active || typeof fn !== 'function') return fn;
	const frame = state.current;
	const bound = function (this: unknown, ...args: unknown[]) {
		return runInFrame(frame, fn as (...a: unknown[]) => unknown, this, args);
	};
	return bound as F;
}

/** Called the first time a store is set: from here on, async work carries the frame. */
export function activateAsyncContext(): void {
	if (state.active) return;
	state.active = true;
	const proto = Promise.prototype as unknown as Record<string, (...a: unknown[]) => unknown>;
	const then = proto.then;
	proto.then = function (this: Promise<unknown>, onFulfilled?: unknown, onRejected?: unknown) {
		return then.call(this, bindToFrame(onFulfilled), bindToFrame(onRejected));
	};
	// catch() and finally() call this.then(), so they are covered.
}

/**
 * The realm's queueMicrotask and timers, carrying the frame to their callbacks. Wrapped as soon
 * as Lifo loads, not on first use: libraries keep a reference from when they load (React's
 * server renderer does `scheduleMicrotask = queueMicrotask`), which is before any store is
 * set. Until one is, bindToFrame returns the callback itself, so they behave exactly as before.
 */
function wrapScheduler(name: string): void {
	const original = g[name];
	if (typeof original !== 'function' || (original as { __lifoAsync?: boolean }).__lifoAsync) return;
	// Always on the realm's global: a browser's own scheduler throws "Illegal invocation" on any
	// other `this`, and code binds these to Lifo's `global` (queue-microtask does).
	const wrapped = function (callback: unknown, ...rest: unknown[]) {
		return (original as (...a: unknown[]) => unknown).call(globalThis, bindToFrame(callback), ...rest);
	};
	// Keep what's attached to the original (Node's setTimeout[util.promisify.custom]).
	for (const key of Reflect.ownKeys(original)) {
		if (key === 'length' || key === 'name' || key === 'prototype') continue;
		const desc = Object.getOwnPropertyDescriptor(original, key);
		if (desc) Object.defineProperty(wrapped, key, desc);
	}
	Object.defineProperty(wrapped, 'name', { value: (original as { name: string }).name });
	Object.defineProperty(wrapped, '__lifoAsync', { value: true });
	g[name] = wrapped;
}
/**
 * Node's setImmediate/clearImmediate for a realm without them (a browser or Web Worker), as
 * globals: Next.js reads globalThis.setImmediate to install its own. On Lifo's event loop
 * (not clamped like a nested setTimeout(0)); returns an Immediate with ref/unref/hasRef, and
 * util.promisify gives a promise of the value.
 */
function installImmediates(): void {
	if (typeof g.setImmediate === 'function') return;
	// On Lifo's event loop (event-loop.ts), with the timers of every node run in this realm, so
	// an immediate runs after the timers that are due, as in Node.
	class Immediate {
		constructor(readonly _task: LoopTask) {}
		ref(): this { return this; }
		unref(): this { return this; }
		hasRef(): boolean { return true; }
		[Symbol.toPrimitive](): number { return this._task.id; }
	}
	const queued = new Map<number, LoopTask>();
	const setImmediate = function setImmediate(callback: (...args: unknown[]) => void, ...args: unknown[]) {
		const task = addImmediate(() => {
			queued.delete(task.id);
			callback(...args);
		});
		queued.set(task.id, task);
		return new Immediate(task);
	};
	Object.defineProperty(setImmediate, Symbol.for('nodejs.util.promisify.custom'), {
		value: <T>(value?: T) => new Promise<T | undefined>((resolve) => setImmediate(() => resolve(value))),
	});
	g.setImmediate = setImmediate;
	g.clearImmediate = function clearImmediate(immediate: unknown) {
		if (immediate === null || immediate === undefined) return;
		const task = immediate instanceof Immediate ? immediate._task : queued.get(Number(immediate));
		if (!task) return;
		queued.delete(task.id);
		cancel(task);
	};
}
/**
 * Async functions compiled at run time: Vite's module runner evaluates every SSR module with
 * `new AsyncFunction(...params, code)` (TanStack Start's server runtime among them), so their
 * awaits never went through the module rewrite and AsyncLocalStorage lost its stores after the
 * first one ("No Start context found in AsyncLocalStorage"). The constructor rewrites the body
 * the same way. Replaced at load, like the schedulers: Vite takes the constructor when it loads.
 */
function instrumentCompiledAsyncFunctions(): void {
	const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as (...args: string[]) => unknown;
	const proto = AsyncFunction.prototype as object;
	const desc = Object.getOwnPropertyDescriptor(proto, 'constructor');
	if (!desc || !desc.configurable || (desc.value as { __lifoAsync?: boolean }).__lifoAsync) return;
	const Instrumented = function (...args: unknown[]) {
		const params = args.map(String);
		if (params.length > 0) params[params.length - 1] = instrumentAwaits(params[params.length - 1]);
		return Reflect.construct(AsyncFunction, params);
	};
	Instrumented.prototype = proto;
	Object.defineProperty(Instrumented, 'name', { value: 'AsyncFunction' });
	Object.defineProperty(Instrumented, '__lifoAsync', { value: true });
	Object.defineProperty(proto, 'constructor', { ...desc, value: Instrumented });
}

installImmediates();
for (const name of ['queueMicrotask', 'setTimeout', 'setInterval', 'setImmediate']) wrapScheduler(name);
instrumentCompiledAsyncFunctions();
