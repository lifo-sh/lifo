import type { Packet } from '../types.js';
import type { NetworkStack } from '../NetworkStack.js';
import { BaseTunnel } from './BaseTunnel.js';
import { Buffer } from '../../../node-compat/buffer.js';
import type { VirtualResponseWithDone } from '../../../node-compat/http.js';
import { getUpgradeHandlers } from '../../../node-compat/http.js';
import { EventEmitter } from '../../../node-compat/events.js';

function bytesToBase64(bytes: Uint8Array): string {
	let bin = '';
	for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
	return btoa(bin);
}

function base64ToBytes(b64: string): Uint8Array {
	const bin = atob(b64);
	const out = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
	return out;
}

const textEncoder = new TextEncoder();

/**
 * Duplex-socket stand-in handed to in-VM WebSocket servers (e.g. Vite's
 * bundled `ws` HMR server) via the http shim's 'upgrade' event. Bytes written
 * by the server (handshake response + WS frames) are relayed to the real
 * browser socket through the tunnel; browser bytes arrive via emit('data').
 */
class VirtualUpgradeSocket extends EventEmitter {
	readable = true;
	writable = true;
	destroyed = false;
	remoteAddress = '127.0.0.1';
	/** Node-internal-shaped state that ws pokes directly on socket close. */
	_readableState = { endEmitted: false, ended: false };
	_writableState = { finished: false, errorEmitted: false, ended: false };

	constructor(
		private sendBytes: (data: Uint8Array) => void,
		private sendClose: () => void,
	) {
		super();
	}

	write(data: string | Uint8Array, encodingOrCb?: unknown, cb?: () => void): boolean {
		const callback = typeof encodingOrCb === 'function' ? (encodingOrCb as () => void) : cb;
		if (!this.destroyed) {
			this.sendBytes(typeof data === 'string' ? textEncoder.encode(data) : data);
		}
		callback?.();
		return true;
	}

	end(data?: string | Uint8Array): void {
		if (data !== undefined && !this.destroyed) this.write(data);
		this.destroy();
	}

	destroy(): this {
		if (this.destroyed) return this;
		this.destroyed = true;
		this.readable = false;
		this.writable = false;
		this._readableState.endEmitted = true;
		this._readableState.ended = true;
		this._writableState.finished = true;
		this.sendClose();
		this.emit('close');
		return this;
	}

	/** Pull-mode read — ws drains remaining bytes on close; nothing is buffered here. */
	read(): null { return null; }
	unshift(_chunk: unknown): void {}

	setTimeout(): this { return this; }
	setNoDelay(): this { return this; }
	setKeepAlive(): this { return this; }
	pause(): this { return this; }
	resume(): this { return this; }
	cork(): void {}
	uncork(): void {}
}

/**
 * WebSocket Tunnel - Bridge virtual network to external WebSocket server
 *
 * This tunnel connects Lifo's virtual network stack to an external WebSocket
 * tunnel server, enabling host machine access to virtual servers.
 *
 * Example:
 *   tunnel --server=ws://localhost:3005
 *
 * Access from host:
 *   http://localhost:3005/3000/ → Port 3000 in virtual network
 */
export class WebSocketTunnel extends BaseTunnel {
	type: 'ssh' = 'ssh'; // Using 'ssh' type for compatibility

	private wsUrl: string;
	private ws: WebSocket | null = null;
	private portRegistry?: Map<number, any>;
	private defaultPort: number | null = null;
	private reconnectTimer?: any;
	private isReconnecting = false;

	// Packet queue
	private packetQueue: Packet[] = [];
	private waitingResolvers: Array<(packet: Packet) => void> = [];

	constructor(
		id: string,
		wsUrl: string,
		networkStack: NetworkStack,
		portRegistry?: Map<number, any>,
		namespace = 'default',
		defaultPort: number | null = null
	) {
		super(id, networkStack, namespace, 1400); // WebSocket overhead

		this.wsUrl = wsUrl;
		this.portRegistry = portRegistry;
		this.defaultPort = defaultPort;

		this.config = {
			mode: 'websocket',
			server: wsUrl,
			ports: portRegistry ? Array.from(portRegistry.keys()) : [],
			defaultPort: defaultPort ?? undefined,
		};
	}

	protected getTunnelPrefix(): string {
		return 'wst';
	}

	/**
	 * Bring tunnel up - connect to WebSocket server
	 */
	override async up(): Promise<void> {
		if (this.state === 'up') {
			return;
		}

		await this.connect();
		this.state = 'up';
		this.interface.up();
	}

	/**
	 * Bring tunnel down - disconnect from WebSocket server
	 */
	override async down(): Promise<void> {
		if (this.state === 'down') {
			return;
		}

		this.isReconnecting = false;

		if (this.reconnectTimer) {
			clearTimeout(this.reconnectTimer);
			this.reconnectTimer = undefined;
		}

		if (this.ws) {
			this.ws.close();
			this.ws = null;
		}

		this.state = 'down';
		this.interface.down();
	}

	/**
	 * Send packet through WebSocket tunnel
	 */
	async send(packet: Packet): Promise<void> {
		if (this.state === 'down' || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
			throw new Error('WebSocket tunnel is not connected');
		}

		try {
			// Serialize packet
			const data = this.serializePacket(packet);

			// Send through WebSocket
			this.ws.send(data);

			// Update stats
			this.updateStats(data.byteLength, 'tx');
		} catch (error) {
			this.updateStats(0, 'tx', true);
			throw error;
		}
	}

	/**
	 * Receive packet from WebSocket tunnel
	 */
	async recv(): Promise<Packet> {
		if (this.state === 'down') {
			throw new Error('WebSocket tunnel is down');
		}

		if (this.packetQueue.length > 0) {
			return this.packetQueue.shift()!;
		}

		return new Promise((resolve) => {
			this.waitingResolvers.push(resolve);
		});
	}

	/**
	 * Connect to WebSocket server
	 */
	private async connect(): Promise<void> {
		return new Promise((resolve, reject) => {
			try {
				// Get WebSocket constructor
				let WebSocketConstructor: typeof WebSocket;

				if (typeof globalThis.WebSocket !== 'undefined') {
					WebSocketConstructor = globalThis.WebSocket;
				} else {
					// Node.js - would need to import ws package
					reject(new Error('WebSocket not available'));
					return;
				}

				this.ws = new WebSocketConstructor(this.wsUrl);

				this.ws.addEventListener('open', () => {
					this.isReconnecting = false;
					// Global HMR bridge: in-VM dev servers (e.g. a Vite plugin) call
					// this to broadcast HMR payloads to browser clients parked at the
					// tunnel relay (which serves the page over plain HTTP forwarding).
					(globalThis as Record<string, unknown>).__lifoHmrBroadcast = (payload: unknown) => {
						if (this.ws && this.ws.readyState === 1) {
							this.ws.send(JSON.stringify({ type: 'hmr-broadcast', payload }));
						}
					};
					resolve();
				});

				this.ws.addEventListener('message', (event) => {
					this.handleMessage(event.data);
				});

				this.ws.addEventListener('close', () => {
					if (this.state === 'up' && !this.isReconnecting) {
						this.scheduleReconnect();
					}
				});

				this.ws.addEventListener('error', (error) => {
					console.error('WebSocket tunnel error:', error);
					if (this.state === 'down') {
						reject(error);
					}
				});

			} catch (error) {
				reject(error);
			}
		});
	}

	/**
	 * Schedule reconnection attempt
	 */
	private scheduleReconnect(): void {
		if (this.isReconnecting) return;

		this.isReconnecting = true;
		this.reconnectTimer = setTimeout(async () => {
			if (this.state === 'up') {
				try {
					await this.connect();
				} catch (error) {
					this.scheduleReconnect();
				}
			}
		}, 5000);
	}

	/**
	 * Handle incoming WebSocket message
	 */
	private handleMessage(data: any): void {
		try {
			const message = JSON.parse(data.toString());

			if (message.type === 'request') {
				// Handle HTTP request from tunnel server
				this.handleHttpRequest(message);
			} else if (message.type === 'response') {
				// Handle response (if we're acting as client)
				this.handleHttpResponse(message);
			} else if (message.type === 'ws-upgrade') {
				this.handleWsUpgrade(message);
			} else if (message.type === 'ws-data') {
				this.wsConns.get(message.connId)?.emit('data', Buffer.from(base64ToBytes(message.data)));
			} else if (message.type === 'ws-close') {
				const sock = this.wsConns.get(message.connId);
				this.wsConns.delete(message.connId);
				sock?.destroy();
			}
		} catch (error) {
			console.error('Error handling WebSocket message:', error);
		}
	}

	/** Live browser WebSocket connections piped through the tunnel, by connId. */
	private wsConns = new Map<string, VirtualUpgradeSocket>();

	/**
	 * Handle a WebSocket upgrade forwarded raw from the tunnel server: hand a
	 * virtual socket to the in-VM server's 'upgrade' listener and pipe bytes
	 * both ways. The in-VM ws library and the real browser then speak the
	 * actual WebSocket frame protocol end-to-end.
	 */
	private handleWsUpgrade(message: { connId: string; url: string; method?: string; headers: Record<string, string> }): void {
		const { connId, url, method, headers } = message;
		const refuse = () => {
			if (this.ws && this.ws.readyState === 1) {
				this.ws.send(JSON.stringify({ type: 'ws-close', connId }));
			}
		};

		let port: number;
		let path: string;
		if (this.defaultPort) {
			port = this.defaultPort;
			path = url || '/';
		} else {
			const match = url.match(/^\/(\d+)(\/.*)?$/);
			if (!match) { refuse(); return; }
			port = parseInt(match[1], 10);
			path = match[2] || '/';
		}

		const upgradeHandler = this.portRegistry ? getUpgradeHandlers(this.portRegistry).get(port) : undefined;
		if (!upgradeHandler) { refuse(); return; }

		let closeSent = false;
		const socket = new VirtualUpgradeSocket(
			(bytes) => {
				if (this.ws && this.ws.readyState === 1) {
					this.ws.send(JSON.stringify({ type: 'ws-data', connId, data: bytesToBase64(bytes) }));
				}
			},
			() => {
				this.wsConns.delete(connId);
				if (!closeSent) {
					closeSent = true;
					refuse();
				}
			},
		);
		this.wsConns.set(connId, socket);

		// The browser's Origin is the relay's (e.g. http://localhost:3005) and its
		// Host targets the relay too — in-VM servers with origin validation
		// (Vite's HMR server compares Origin against its own host) rightly
		// reject that pair. The tunnel relay is loopback-only dev tooling, so
		// present the connection the way a local non-browser client would:
		// without an Origin header.
		const fwdHeaders = { ...headers };
		delete fwdHeaders.origin;
		delete fwdHeaders.Origin;

		const delivered = upgradeHandler(
			{ method: method || 'GET', url: path, headers: fwdHeaders },
			socket,
			new Uint8Array(0),
		);
		if (!delivered) {
			this.wsConns.delete(connId);
			socket.destroy();
		}
	}

	/**
	 * Handle HTTP request from tunnel server
	 */
	private async handleHttpRequest(message: any): Promise<void> {
		const { requestId, method, url, headers, body } = message;

		let port: number;
		let path: string;

		if (this.defaultPort) {
			// Default port mode: all requests go to the default port
			port = this.defaultPort;
			path = url || '/';
		} else {
			// Path-based routing: /PORT/path
			const match = url.match(/^\/(\d+)(\/.*)?$/);

			if (!match) {
				this.sendError(requestId, 400, 'Invalid URL format. Use /PORT/path or configure default port');
				return;
			}

			port = parseInt(match[1], 10);
			path = match[2] || '/';
		}

		// Check if port exists in registry
		if (!this.portRegistry || !this.portRegistry.has(port)) {
			this.sendError(requestId, 404, `No server listening on port ${port}`);
			return;
		}

		// Get handler
		const handler = this.portRegistry.get(port);

		// Create virtual request/response
		const vReq = {
			method,
			url: path,
			headers,
			body: Buffer.from(body || '', 'base64').toString(),
		};

		const vRes: VirtualResponseWithDone = {
			statusCode: 200,
			headers: {} as Record<string, string>,
			body: '',
		};

		try {
			// Call handler
			handler(vReq, vRes);

			// Wait for async middleware to call res.end() (populates vRes)
			// Add a 25s safety timeout so we respond before external timeout
			if (vRes._donePromise) {
				const timeout = new Promise<'timeout'>((resolve) =>
					setTimeout(() => resolve('timeout'), 25000)
				);
				const result = await Promise.race([vRes._donePromise.then(() => 'done' as const), timeout]);
				if (result === 'timeout') {
					console.error(`[WebSocketTunnel] TIMEOUT waiting for response: ${method} ${path}`);
					this.sendError(requestId, 504, `Gateway timeout: server did not respond for ${path}`);
					return;
				}
			}

			// Send response back through WebSocket (binary-safe via bodyBytes)
			const outBytes = vRes.bodyBytes ?? new TextEncoder().encode(vRes.body);
			this.sendResponse(requestId, vRes.statusCode, vRes.headers, outBytes);

			// Update stats
			this.updateStats(outBytes.length, 'tx');
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error);
			this.sendError(requestId, 500, `Internal server error: ${errorMessage}`);
		}
	}

	/**
	 * Handle HTTP response (for client-side requests)
	 */
	private handleHttpResponse(_message: any): void {
		// For future client-side request support
		// Not needed for current server-only implementation
	}

	/**
	 * Send HTTP response through WebSocket
	 */
	private sendResponse(requestId: string, statusCode: number, headers: Record<string, string>, body: string | Uint8Array): void {
		if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
			return;
		}

		const response = {
			type: 'response',
			requestId,
			statusCode,
			headers,
			body: Buffer.from(body).toString('base64'),
		};

		this.ws.send(JSON.stringify(response));
	}

	/**
	 * Send error response through WebSocket
	 */
	private sendError(requestId: string, statusCode: number, message: string): void {
		if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
			return;
		}

		const response = {
			type: 'response',
			requestId,
			statusCode,
			headers: { 'Content-Type': 'text/plain' },
			body: Buffer.from(message).toString('base64'),
		};

		this.ws.send(JSON.stringify(response));
	}

	/**
	 * Serialize packet to bytes
	 */
	private serializePacket(packet: Packet): ArrayBuffer {
		const header = new Uint8Array(9);
		const view = new DataView(header.buffer);

		view.setUint16(0, packet.source.port);
		view.setUint16(2, packet.destination.port);
		view.setUint8(4, packet.protocol === 'tcp' ? 6 : 17);
		view.setUint32(5, packet.data.length);

		const combined = new Uint8Array(header.length + packet.data.length);
		combined.set(header);
		combined.set(packet.data, header.length);

		return combined.buffer;
	}

	/**
	 * Get tunnel status string
	 */
	override toString(): string {
		const base = super.toString();
		const server = this.wsUrl;
		const connected = this.ws && this.ws.readyState === WebSocket.OPEN ? '✓' : '✗';
		const ports = this.portRegistry ? Array.from(this.portRegistry.keys()).join(',') : 'none';
		return `${base} ${server} [${connected}] ports=${ports}`;
	}

	/**
	 * Get connection status
	 */
	isConnected(): boolean {
		return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
	}

	/**
	 * Get active ports
	 */
	getActivePorts(): number[] {
		return this.portRegistry ? Array.from(this.portRegistry.keys()).sort((a, b) => a - b) : [];
	}
}
