/**
 * A box on another origin: the strongest isolation a box in a browser can have.
 *
 * A box in a same-origin Web Worker (WorkerSandbox) can't touch the page, but it still shares the
 * site's origin: its IndexedDB, its Cache Storage, and anything the browser sends cookies with
 * when a script or module is loaded. Here the worker is created by a tiny host page on a
 * different site (the "box origin", e.g. a separate domain), inside a hidden iframe, and the page
 * only gets a MessagePort to it. The box can't reach the site's cookies, storage or IndexedDB at
 * all, because to the browser it is another site.
 *
 *   page (lifo.sh)                          box origin (another site)
 *   ┌──────────────────────┐   iframe   ┌────────────────────────────┐
 *   │ WorkerSandbox ───────┼── port ───▶│ /box-host → Worker (box)   │
 *   │ preview <iframe> ────┼──────────▶ │ /_sw/ preview service worker│
 *   └──────────────────────┘            └────────────────────────────┘
 *
 * Three pieces:
 * - `openBoxFrame()` on the page: makes the iframe, does the handshake, returns the port.
 * - `serveBoxFrame()` on the host page: answers only allowed parent origins, starts the worker,
 *   hands over its port, and connects previews to the box origin's service worker.
 * - `serveSandboxWhenConnected()` in the worker: serves the box on the port it's handed.
 *
 * The handshake: the host says `lifo-box-host-ready` to each allowed origin; the page answers
 * `lifo-box-connect` with a nonce (to the box origin only); the host starts the worker and posts
 * `lifo-box-port` back to that origin with two ports: one for the box (RPC), one for control
 * (previews, close). Every message is checked for origin and source on both sides.
 */

import type { Endpoint } from './rpc.js';
import { serveSandbox, type ServeSandboxOptions } from './host.js';

export interface BoxFrameOptions {
	/** The box origin, e.g. `https://box.example.net`. It must be a different site from the page. */
	origin: string;
	/** The host page's path on the box origin. Default `/box-host`. */
	path?: string;
	/** How long to wait for the host to answer. Default 30 s. */
	timeoutMs?: number;
	/** Where to put the hidden iframe. Default `document.body`. */
	container?: HTMLElement;
}

/** The page's end of a box on another origin: a port to the box, plus control. */
export interface BoxFrame {
	/** The box origin, normalized. */
	readonly origin: string;
	/** The port the box is served on (an RPC endpoint for WorkerSandbox). */
	readonly port: MessagePort;
	/** Hand the box origin's preview service worker one end of a channel to the box. */
	connectPreviews(boxId: string, port: MessagePort): void;
	/** Called when the preview service worker restarted and needs its channels again. */
	onNeedHost(cb: () => void): () => void;
	/** Stop the box (the worker) and remove the iframe. */
	close(): void;
}

type Ready = { type: 'lifo-box-host-ready' };
type PortMsg = { type: 'lifo-box-port'; nonce: string };
type ErrorMsg = { type: 'lifo-box-error'; nonce: string; message: string };

/** Open a box on another origin (page side). */
export function openBoxFrame(options: BoxFrameOptions): Promise<BoxFrame> {
	const origin = new URL(options.origin).origin;
	if (typeof location !== 'undefined' && origin === location.origin) {
		return Promise.reject(new Error(`The box origin (${origin}) must be different from the page's origin`));
	}
	const iframe = document.createElement('iframe');
	iframe.src = origin + (options.path ?? '/box-host');
	iframe.title = 'Lifo box';
	iframe.setAttribute('aria-hidden', 'true');
	iframe.tabIndex = -1;
	// Scripts and its own origin (it needs both: a worker, and a service worker for previews), and
	// nothing else: no navigating the page, no popups, no forms.
	iframe.setAttribute('sandbox', 'allow-scripts allow-same-origin');
	iframe.style.cssText = 'position:absolute;width:0;height:0;border:0;visibility:hidden;pointer-events:none';
	const nonce = crypto.randomUUID();

	return new Promise<BoxFrame>((resolve, reject) => {
		const timer = setTimeout(() => {
			cleanup();
			iframe.remove();
			reject(new Error(`The box host at ${origin} didn't answer`));
		}, options.timeoutMs ?? 30_000);
		const cleanup = () => {
			clearTimeout(timer);
			window.removeEventListener('message', onMessage);
		};
		const onMessage = (event: MessageEvent) => {
			if (event.origin !== origin || event.source !== iframe.contentWindow) return;
			const data = event.data as Ready | PortMsg | ErrorMsg | null;
			if (data?.type === 'lifo-box-host-ready') {
				iframe.contentWindow?.postMessage({ type: 'lifo-box-connect', nonce }, origin);
			} else if (data?.type === 'lifo-box-port' && data.nonce === nonce && event.ports.length === 2) {
				cleanup();
				const [port, control] = event.ports;
				const needHost = new Set<() => void>();
				control.onmessage = (m) => {
					if ((m.data as { type?: string } | null)?.type === 'need-host') needHost.forEach((cb) => cb());
				};
				resolve({
					origin,
					port,
					connectPreviews(boxId, previewPort) {
						control.postMessage({ type: 'previews', boxId }, [previewPort]);
					},
					onNeedHost(cb) {
						needHost.add(cb);
						return () => needHost.delete(cb);
					},
					close() {
						try {
							control.postMessage({ type: 'close' });
						} catch {
							// already closed
						}
						port.close();
						control.close();
						iframe.remove();
					},
				});
			} else if (data?.type === 'lifo-box-error' && data.nonce === nonce) {
				cleanup();
				iframe.remove();
				reject(new Error(data.message));
			}
		};
		window.addEventListener('message', onMessage);
		(options.container ?? document.body).appendChild(iframe);
	});
}

export interface ServeBoxFrameOptions {
	/** The pages allowed to use boxes from this origin (e.g. `https://lifo.sh`). Nobody else is answered. */
	allowedOrigins: string[];
	/** Start the box's worker (it runs `serveSandboxWhenConnected`). */
	createWorker(): Worker;
	/** The preview service worker on this origin, if previews are served. */
	serviceWorker?: { url: string; scope: string };
}

function waitForActive(reg: ServiceWorkerRegistration): Promise<ServiceWorker> {
	if (reg.active) return Promise.resolve(reg.active);
	return new Promise((resolve) => {
		const check = () => reg.active && resolve(reg.active);
		const track = (w: ServiceWorker | null) => w?.addEventListener('statechange', check);
		track(reg.installing);
		track(reg.waiting);
		reg.addEventListener('updatefound', () => track(reg.installing));
	});
}

/**
 * Serve one box to an allowed parent page (host page side, on the box origin). Does nothing when
 * the page isn't framed. One box per host page; the parent makes one iframe per box.
 */
export function serveBoxFrame(options: ServeBoxFrameOptions): void {
	if (typeof window === 'undefined' || window.parent === window) return;
	const allowed = new Set(options.allowedOrigins.map((o) => new URL(o).origin));
	let connected = false;

	window.addEventListener('message', (event: MessageEvent) => {
		const data = event.data as { type?: string; nonce?: unknown } | null;
		if (data?.type !== 'lifo-box-connect' || connected) return;
		if (event.source !== window.parent || !allowed.has(event.origin)) return;
		const nonce = typeof data.nonce === 'string' ? data.nonce : '';
		const reply = (msg: unknown, transfer: Transferable[] = []) =>
			(event.source as Window).postMessage(msg, { targetOrigin: event.origin, transfer });
		connected = true;
		let worker: Worker;
		try {
			worker = options.createWorker();
		} catch (err) {
			reply({ type: 'lifo-box-error', nonce, message: `Couldn't start the box: ${(err as Error).message}` });
			return;
		}
		const box = new MessageChannel();
		worker.postMessage({ type: 'lifo-box-port' }, [box.port2]);

		const control = new MessageChannel();
		let registration: Promise<ServiceWorkerRegistration> | null = null;
		const sw = options.serviceWorker;
		if (sw && 'serviceWorker' in navigator) {
			navigator.serviceWorker.addEventListener('message', (e: MessageEvent) => {
				if ((e.data as { type?: string } | null)?.type === 'lifo-need-host') control.port1.postMessage({ type: 'need-host' });
			});
			navigator.serviceWorker.startMessages();
		}
		control.port1.onmessage = async (m) => {
			const msg = m.data as { type?: string; boxId?: unknown } | null;
			if (msg?.type === 'previews' && sw && 'serviceWorker' in navigator && typeof msg.boxId === 'string' && m.ports[0]) {
				registration ??= navigator.serviceWorker.register(sw.url, { scope: sw.scope }).then(async (reg) => {
					await waitForActive(reg);
					return reg;
				});
				const reg = await registration;
				(reg.active ?? (await waitForActive(reg))).postMessage({ type: 'lifo-connect', boxId: msg.boxId }, [m.ports[0]]);
			} else if (msg?.type === 'close') {
				worker.terminate();
				control.port1.close();
			}
		};
		reply({ type: 'lifo-box-port', nonce }, [box.port1, control.port2]);
	});

	for (const origin of allowed) window.parent.postMessage({ type: 'lifo-box-host-ready' }, origin);
}

/**
 * In a box's worker started by `serveBoxFrame`: serve the box on the port the host page hands
 * over (instead of on the worker's own global, which only the host page can reach).
 */
export function serveSandboxWhenConnected(scope: Endpoint, options: ServeSandboxOptions = {}): void {
	const onMessage = (event: { data: unknown; ports?: readonly MessagePort[] }) => {
		const data = event.data as { type?: string } | null;
		const port = event.ports?.[0];
		if (data?.type !== 'lifo-box-port' || !port) return;
		scope.removeEventListener('message', onMessage as (e: { data: unknown }) => void);
		serveSandbox(port as unknown as Endpoint, options);
	};
	scope.addEventListener('message', onMessage as (e: { data: unknown }) => void);
}
