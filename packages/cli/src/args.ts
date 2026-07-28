/**
 * args.ts — argument parsing helpers, kept out of index.ts so they can be tested.
 *
 * `index.ts` calls `main()` at import time, so anything exported from there is
 * unreachable from a test without booting the CLI. Pure parsing lives here
 * instead.
 */

/** An `--expose vmPort[:hostPort]` mapping. */
export interface ExposeMapping {
	vmPort: number;
	hostPort: number;
}

const isPort = (n: number): boolean => Number.isInteger(n) && n >= 1 && n <= 65535;

/**
 * Parse `--expose 3000` or `--expose 3000:8080`.
 *
 * `hostPort` defaults to `vmPort`, so the common case needs no colon. Returns
 * `null` for anything unparseable — the caller reports it and exits, rather than
 * silently forwarding a port nobody asked for.
 */
export function parseExpose(spec: string): ExposeMapping | null {
	const parts = spec.split(':');
	if (parts.length > 2) return null;

	const [left, right] = parts;
	if (!left) return null;

	const vmPort = Number(left);
	const hostPort = right === undefined || right === '' ? vmPort : Number(right);
	if (!isPort(vmPort) || !isPort(hostPort)) return null;
	return { vmPort, hostPort };
}
