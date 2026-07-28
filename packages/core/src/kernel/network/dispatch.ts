/**
 * dispatch.ts — the one place that knows how to call an in-VM HTTP server.
 *
 * Every transport that reaches a server inside the VM (the service worker, the
 * SW-free blob preview, curl, the tunnel relay, `sandbox.fetch`) needs the same
 * three-step dance, and each used to reimplement it:
 *
 *   1. call the handler synchronously
 *   2. if it set `_donePromise`, await that — this is how async servers
 *      (Express, Vite, Metro, tinbase) signal they have finished writing
 *   3. read `bodyBytes` (binary-safe) and fall back to encoding the text view
 *
 * Step 2 is the one that gets forgotten: `PortBridge.handleRequest` skipped it
 * and so returned an empty 200 for every async server. Extracting it here makes
 * the contract typed and testable instead of tribal knowledge.
 *
 * Errors are RESPONSES, not exceptions — an unbound port, a timeout and a
 * throwing handler all resolve with a status. Transports need a status code to
 * hand back to a browser, and the service worker has always behaved this way.
 */

import type { VirtualRequestHandler, VirtualResponse } from '../index.js';

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

/**
 * 120s, not 25s: a dev bundler's FIRST bundle (Metro compiling hundreds of
 * modules through Babel INSIDE the VM) legitimately exceeds 25s, which surfaced
 * as spurious 504s on `GET /index.bundle`. Still bounded, so a genuinely stuck
 * handler fails instead of hanging forever.
 */
export const DEFAULT_DISPATCH_TIMEOUT_MS = 120_000;

/**
 * Marker header distinguishing a response the dispatcher synthesized from one
 * the app actually produced: `no-server` (nothing bound), `timeout` (we gave up
 * waiting) and `handler-error` (the handler threw). Without it, callers can't
 * tell our 504 from an app's own 504 — curl, for instance, must exit 7 on the
 * former and 0 on the latter.
 */
export const LIFO_HEADER = 'x-lifo';

/**
 * Response headers that make sense for a server on the public internet but not
 * for one running inside the page, and that actively break a preview.
 *
 * A preview renders an in-VM server's document in a same-origin iframe. If the
 * server sends `X-Frame-Options: DENY` or a CSP with `frame-ancestors 'none'`,
 * the browser refuses to render it and the preview is blank — even though there
 * is no cross-origin embedding happening and nothing to protect: the "server" is
 * a JavaScript object in the very tab doing the framing.
 *
 * This is not one library's quirk. `helmet()` sets `X-Frame-Options: DENY` by
 * default, so any Express app using it hits this, as does tinbase's studio.
 *
 * CSP goes too, not just its `frame-ancestors`: preview transports inject a small
 * inline script into VM-served documents (to strip the URL prefix so client
 * routers see a clean path), and a `script-src 'self'` policy blocks it. A
 * dev preview of your own code is not the place to enforce a production CSP.
 *
 * Stripped only on the PREVIEW path. Tunnels, `curl` and `sandbox.fetch` see
 * exactly what the server sent.
 */
export const PREVIEW_STRIPPED_HEADERS = [
	'x-frame-options',
	'content-security-policy',
	'content-security-policy-report-only',
];

/**
 * Copy `headers` without the headers that break framing a preview.
 * Case-insensitive: header names arrive however the server wrote them.
 */
export function stripPreviewBlockingHeaders(headers: Record<string, string>): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [key, value] of Object.entries(headers)) {
		if (!PREVIEW_STRIPPED_HEADERS.includes(key.toLowerCase())) out[key] = value;
	}
	return out;
}

export interface DispatchInit {
	method?: string;
	/** Path + query as the server sees it, e.g. `/rest/v1/todos?select=*`. */
	url: string;
	headers?: Record<string, string>;
	/**
	 * Request body. `VirtualRequest.body` is a string, so bytes are decoded as
	 * UTF-8 before reaching the handler — the same (lossy for binary uploads)
	 * behaviour every transport already had.
	 */
	body?: string | Uint8Array;
}

export interface DispatchOptions {
	timeoutMs?: number;
}

/** A VirtualResponse with `bodyBytes` guaranteed present. */
export type DispatchedResponse = VirtualResponse & { bodyBytes: Uint8Array };

function textResponse(statusCode: number, headers: Record<string, string>, body: string): DispatchedResponse {
	return { statusCode, headers, body, bodyBytes: textEncoder.encode(body) };
}

/**
 * Send one HTTP request to the server listening on `port` inside the VM.
 *
 * Always resolves:
 * - no handler bound → `404` with `x-lifo: no-server` (what the service worker
 *   returns, so a caller can tell "port not bound" from an app's own 404)
 * - handler exceeded the timeout → `504`
 * - handler threw → `500`
 */
export async function dispatchRequest(
	portRegistry: Map<number, VirtualRequestHandler>,
	port: number,
	init: DispatchInit,
	options: DispatchOptions = {},
): Promise<DispatchedResponse> {
	const handler = portRegistry.get(port);
	if (!handler) {
		return textResponse(
			404,
			{ 'content-type': 'text/plain', [LIFO_HEADER]: 'no-server' },
			`No server listening on port ${port}`,
		);
	}

	const body = typeof init.body === 'string'
		? init.body
		: init.body
			? textDecoder.decode(init.body)
			: '';

	const vReq = {
		method: init.method ?? 'GET',
		url: init.url,
		headers: init.headers ?? {},
		body,
	};
	const vRes: VirtualResponse = { statusCode: 200, headers: {}, body: '' };

	try {
		handler(vReq, vRes);

		if (vRes._donePromise) {
			let timer: ReturnType<typeof setTimeout> | undefined;
			const timeout = new Promise<'timeout'>((resolve) => {
				timer = setTimeout(() => resolve('timeout'), options.timeoutMs ?? DEFAULT_DISPATCH_TIMEOUT_MS);
			});
			try {
				const result = await Promise.race([vRes._donePromise.then(() => 'done' as const), timeout]);
				if (result === 'timeout') {
					return textResponse(
						504,
						{ 'content-type': 'text/plain', [LIFO_HEADER]: 'timeout' },
						`Gateway timeout: server did not respond for ${init.url}`,
					);
				}
			} finally {
				// Don't leave a 120s timer holding the event loop open — this is what
				// makes a headless Node process hang after its last request.
				if (timer) clearTimeout(timer);
			}
		}

		return {
			statusCode: vRes.statusCode,
			headers: vRes.headers,
			body: vRes.body,
			bodyBytes: vRes.bodyBytes ?? textEncoder.encode(vRes.body),
		};
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return textResponse(
			500,
			{ 'content-type': 'text/plain', [LIFO_HEADER]: 'handler-error' },
			`Internal server error: ${message}`,
		);
	}
}

/**
 * Resolve once a server is listening on `port`, or reject on timeout.
 *
 * "Bound" is the only readiness signal the port registry has — it cannot tell
 * whether the server is done warming up. Callers that need a real page should
 * poll a request instead (the preview transports do exactly that).
 */
export async function waitForPort(
	portRegistry: Map<number, VirtualRequestHandler>,
	port: number,
	options: { timeout?: number; intervalMs?: number } = {},
): Promise<void> {
	const timeout = options.timeout ?? 30_000;
	const intervalMs = options.intervalMs ?? 100;
	const deadline = Date.now() + timeout;
	while (Date.now() < deadline) {
		if (portRegistry.has(port)) return;
		await new Promise((resolve) => setTimeout(resolve, intervalMs));
	}
	if (portRegistry.has(port)) return;
	throw new Error(`Timed out after ${timeout}ms waiting for a server on port ${port}`);
}
