/**
 * Node's event-loop order for timers and immediates, where the host has no such loop (a browser
 * page or Web Worker). Hosts that have one (Node, Bun, Deno: they have setImmediate) keep using
 * it, and nothing here runs there.
 *
 * Node runs a loop iteration in phases: first every timer that is due when the timers phase
 * begins, in order, then every immediate that was queued when the check phase begins, with
 * microtasks drained after each callback. Browsers give no such guarantee: two timers scheduled
 * back to back are separate tasks, and a message (Lifo's setImmediate) posted from the first one
 * can run before the second. Next.js renders in stages that depend on Node's order (its
 * "atomic timer groups": the stage timers run back to back, with React's immediates after them),
 * so a box keeps its own queue of timers and immediates and runs one callback per task in
 * Node's order. Each callback is its own task, so microtasks drain between callbacks, as in Node.
 *
 * Times are whole milliseconds, like libuv's loop time, so timers scheduled together share a
 * start and run in the same timers phase. A timer's start can be moved (Node's `_idleStart`,
 * which Next.js aligns across a group).
 *
 * process.nextTick: Node runs the tick queue before promise callbacks, and a tick scheduled
 * from inside a promise callback only once the whole microtask queue is empty (just before the
 * next task). Next.js runs React's work "at the end of the current task" that way. In the
 * synchronous part of a loop task, a tick is a microtask (ahead of the promise callbacks the
 * rest of that code queues); anywhere else it waits for the next loop task, which runs pending
 * ticks before any timer or immediate.
 */

const g = globalThis as unknown as {
	setImmediate?: unknown;
	setTimeout: (fn: () => void, ms: number) => unknown;
	clearTimeout: (id: unknown) => void;
};

/** The host has an event loop of its own with Node's phases (Node, Bun, Deno). */
export const hostHasNodeLoop = typeof g.setImmediate === 'function';

const hostProcess = (globalThis as { process?: { nextTick?: (fn: () => void) => void } }).process;
const hostNextTick = hostHasNodeLoop && typeof hostProcess?.nextTick === 'function'
	? hostProcess.nextTick.bind(hostProcess)
	: null;

// The host's own timer functions, taken before anything wraps them (async-context wraps the
// realm's for AsyncLocalStorage; the loop binds each callback itself).
const hostSetTimeout = g.setTimeout.bind(globalThis);
const hostClearTimeout = g.clearTimeout.bind(globalThis);
const now = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());

export interface LoopTask {
	/** Number form of the task (what a Timeout coerces to), distinct from the host's timer ids. */
	readonly id: number;
	/** The loop time (whole ms) the timer was started at: Node's `_idleStart`. */
	start: number;
	/** Delay in ms: Node's `_idleTimeout`. */
	readonly delay: number;
	due: number;
	readonly seq: number;
	readonly fn: () => void;
	done: boolean;
}

let nextId = 2 ** 30; // clear of the small ids browsers give their own timers
let nextSeq = 0;
/** Pending timers, sorted by due time, then by the order they were scheduled. */
const timers: LoopTask[] = [];
/** Immediates for the next check phase. */
let immediates: LoopTask[] = [];

/** The loop's time in whole ms (libuv's `uv_now`). */
export function loopTime(): number {
	return Math.floor(now());
}

function insertTimer(t: LoopTask): void {
	let lo = 0;
	let hi = timers.length;
	while (lo < hi) {
		const mid = (lo + hi) >> 1;
		const m = timers[mid];
		if (m.due < t.due || (m.due === t.due && m.seq < t.seq)) lo = mid + 1;
		else hi = mid;
	}
	timers.splice(lo, 0, t);
}

function removeTimer(t: LoopTask): void {
	const i = timers.indexOf(t);
	if (i !== -1) timers.splice(i, 1);
}

/** Schedules fn after `delay` ms (Node clamps anything below 1 to 1). */
export function addTimer(fn: () => void, delay: number): LoopTask {
	const ms = delay >= 1 && delay <= 2 ** 31 - 1 ? delay : 1;
	const start = loopTime();
	const t: LoopTask = { id: nextId++, start, delay: ms, due: start + ms, seq: nextSeq++, fn, done: false };
	insertTimer(t);
	wake();
	return t;
}

/** Moves a pending timer's start (Node's writable `_idleStart`): it keeps its place among equals. */
export function retime(t: LoopTask, start: number): void {
	if (t.done) return;
	removeTimer(t);
	t.start = start;
	t.due = start + t.delay;
	insertTimer(t);
	wake();
}

export function addImmediate(fn: () => void): LoopTask {
	const t: LoopTask = { id: nextId++, start: 0, delay: 0, due: 0, seq: nextSeq++, fn, done: false };
	immediates.push(t);
	wake();
	return t;
}

export function cancel(t: LoopTask): void {
	if (t.done) return;
	t.done = true;
	removeTimer(t);
	// A cancelled immediate stays queued and is skipped when its turn comes.
}

// ─── process.nextTick ───

const ticks: Array<() => void> = [];
let tickMicrotaskQueued = false;
let drainingTicks = false;
/** True during the synchronous part of a loop task (cleared by the first microtask after it). */
let stepSync = false;

/** Queues fn as process.nextTick does (see the top of this file). */
export function scheduleTick(fn: () => void): void {
	if (hostNextTick) {
		hostNextTick(fn);
		return;
	}
	ticks.push(fn);
	if (drainingTicks) return; // the running drain picks it up, as Node's tick loop does
	if (stepSync) {
		if (tickMicrotaskQueued) return;
		tickMicrotaskQueued = true;
		queueMicrotask(() => {
			tickMicrotaskQueued = false;
			drainTicks();
		});
		return;
	}
	post();
}

function drainTicks(): void {
	drainingTicks = true;
	try {
		while (ticks.length > 0) ticks.shift()!();
	} finally {
		drainingTicks = false;
		// A tick that threw leaves the rest for the next loop task.
		if (ticks.length > 0) post();
	}
}

// ─── Driving the loop ───

let posted = false;
let armedFor = Infinity;
let armed: unknown = null;
const channel = !hostHasNodeLoop && typeof MessageChannel === 'function' ? new MessageChannel() : null;
if (channel) channel.port1.onmessage = () => step();

function post(): void {
	if (posted) return;
	posted = true;
	if (channel) channel.port2.postMessage(0);
	else hostSetTimeout(() => step(), 0);
}

/** Runs the loop now if it has something to run, else wakes it when the next timer is due. */
function wake(): void {
	if (posted) return;
	if (inIteration || ticks.length > 0 || immediates.length > 0 || (timers.length > 0 && timers[0].due <= now())) {
		post();
		return;
	}
	if (timers.length === 0) return;
	const due = timers[0].due;
	if (armed !== null && armedFor <= due) return;
	if (armed !== null) hostClearTimeout(armed);
	armedFor = due;
	armed = hostSetTimeout(() => {
		armed = null;
		armedFor = Infinity;
		post();
	}, Math.max(0, due - now()));
}

let inIteration = false;
let phase: 'timers' | 'check' = 'timers';
let phaseTime = 0;
let checkQueue: LoopTask[] = [];

/** One callback per task, in Node's phase order. */
function step(): void {
	posted = false;
	stepSync = true;
	queueMicrotask(endStepSync);
	// Ticks left by promise callbacks go first: the microtask queue is empty now.
	if (ticks.length > 0) {
		post();
		drainTicks();
		return;
	}
	if (!inIteration) {
		inIteration = true;
		phase = 'timers';
		phaseTime = now();
	}
	if (phase === 'timers') {
		const t = timers[0];
		if (t && t.due <= phaseTime) {
			timers.shift();
			t.done = true;
			run(t);
			return;
		}
		phase = 'check';
		checkQueue = immediates;
		immediates = [];
	}
	while (checkQueue.length > 0) {
		const t = checkQueue.shift()!;
		if (t.done) continue;
		t.done = true;
		run(t);
		return;
	}
	inIteration = false;
	wake();
}

function endStepSync(): void {
	stepSync = false;
}

function run(t: LoopTask): void {
	// The next step is queued first, so a callback that throws (reported by the host as an
	// uncaught error, as Node would) doesn't stop the loop.
	post();
	t.fn();
}
