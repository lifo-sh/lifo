/**
 * Pending work a `node` run is waiting on, so the run can end when its program is done.
 *
 * Real Node exits when its event loop has nothing ref'd left: no timers, sockets or pending
 * I/O. A program in a box runs on the host's event loop, which Lifo can't inspect, so the
 * parts of the Node layer that start asynchronous work report it here instead: each timer,
 * outgoing HTTP request and so on calls `begin()` and then the function it returns when the
 * work is over. The node runner ends the run once nothing is pending (see node.ts).
 *
 * One tracker per run, not per page: a dev server running in the background with its own
 * intervals must not keep every later `node -e` waiting.
 */

export interface ActivityTracker {
	/** Mark one piece of work as started; call the returned function (once) when it's over. */
	begin(): () => void;
	/** How many pieces of work are in flight. */
	pending(): number;
}

export function createActivityTracker(): ActivityTracker {
	let count = 0;
	return {
		begin() {
			count++;
			let ended = false;
			return () => {
				if (ended) return;
				ended = true;
				count--;
			};
		},
		pending: () => count,
	};
}

// ─── WebAssembly ───
// Compiling or instantiating a module is asynchronous and can take hundreds of milliseconds
// (esbuild-wasm, SWC). It can't be attributed to one run, but it's short-lived, so it's
// counted page-wide: a run whose program is waiting on a compile keeps waiting.

let wasmPending = 0;

export function pendingWasm(): number {
	return wasmPending;
}

let wasmPatched = false;

/** Count WebAssembly compiles/instantiations in flight. Idempotent; a no-op without WebAssembly. */
export function trackWebAssembly(): void {
	if (wasmPatched) return;
	wasmPatched = true;
	const wa = (globalThis as { WebAssembly?: Record<string, unknown> }).WebAssembly;
	if (!wa) return;
	for (const name of ['compile', 'instantiate', 'compileStreaming', 'instantiateStreaming']) {
		const original = wa[name];
		if (typeof original !== 'function') continue;
		try {
			wa[name] = function (this: unknown, ...args: unknown[]) {
				wasmPending++;
				let result: unknown;
				try {
					result = (original as (...a: unknown[]) => unknown).apply(this, args);
				} catch (e) {
					wasmPending--;
					throw e;
				}
				return Promise.resolve(result).finally(() => {
					wasmPending--;
				});
			};
		} catch {
			// A frozen WebAssembly namespace: leave it alone.
		}
	}
}
