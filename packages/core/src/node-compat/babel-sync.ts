/**
 * Proxy wrapper that routes @babel/core's async API through its sync
 * implementations.
 *
 * Babel's async pipeline (gensync) stalls indefinitely when invoked from
 * inside a long-lived in-VM server process (observed with Vite's
 * plugin-react calling transformAsync — the same call with identical options
 * completes in a standalone VM process; root cause not yet isolated). The
 * sync pipeline is reliable, and in a single-threaded VM there is no
 * concurrency benefit to the async path — so we transparently answer the
 * async API with sync execution.
 */

const ASYNC_TO_SYNC: Record<string, string> = {
	transformAsync: 'transformSync',
	transformFromAstAsync: 'transformFromAstSync',
	transformFileAsync: 'transformFileSync',
	parseAsync: 'parseSync',
	loadPartialConfigAsync: 'loadPartialConfig',
};

export function wrapBabelSync(babel: Record<string, unknown>): Record<string, unknown> {
	return new Proxy(babel, {
		get(target, prop, receiver) {
			const syncName = typeof prop === 'string' ? ASYNC_TO_SYNC[prop] : undefined;
			if (syncName) {
				const syncFn = (target as Record<string, unknown>)[syncName];
				if (typeof syncFn === 'function') {
					return async (...args: unknown[]) =>
						(syncFn as (...a: unknown[]) => unknown).apply(target, args);
				}
			}
			return Reflect.get(target, prop, receiver);
		},
	});
}
