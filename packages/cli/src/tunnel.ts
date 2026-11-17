/**
 * tunnel.ts — `lifo-sh tunnel <port> [--name <name>]` on the host.
 *
 * Shares a port on this machine through the lifo tunnel server, using the same
 * client as `lifo tunnel` inside a box (@lifo-sh/core runTunnel). Only the far
 * end differs: requests go to http://localhost:<port> with node:http, and
 * WebSocket upgrades are piped as raw bytes over a TCP socket, so the local
 * server does its own handshake (Vite and Metro HMR work unchanged).
 *
 * Inside the box this CLI boots, `tunnel` / `lifo tunnel` share the box's own
 * ports instead (core's lifo-cloud.ts); see index.ts.
 */

import * as http from 'node:http';
import * as net from 'node:net';
import WebSocket from 'ws';
import { fetchCliConfig, runTunnel, type TunnelForwarder } from '@lifo-sh/core';
import { resolveHostAuth, takeBaseUrlFlag } from './auth.js';

type Headers = Record<string, string | string[] | undefined>;

const HOP_BY_HOP = ['connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'proxy-connection', 'te', 'trailer'];

/** The visitor's request as the local server should see it: from a browser on this machine. */
function toLocal(headers: Headers, port: number, opts: { upgrade?: boolean } = {}): http.OutgoingHttpHeaders {
	const out: http.OutgoingHttpHeaders = {};
	for (const [k, v] of Object.entries(headers)) {
		const key = k.toLowerCase();
		if (v === undefined || (!opts.upgrade && HOP_BY_HOP.includes(key))) continue;
		out[key] = v;
	}
	// Dev servers refuse unknown Host headers (Vite's allowedHosts), and Vite's HMR
	// socket refuses a foreign Origin.
	out.host = `localhost:${port}`;
	if (opts.upgrade) delete out.origin;
	return out;
}

export function createHostForwarder(port: number): TunnelForwarder {
	return {
		http(req) {
			return new Promise((resolve, reject) => {
				const headers = toLocal(req.headers, port);
				if (req.body.length) headers['content-length'] = req.body.length;
				else delete headers['content-length'];
				const out = http.request({ host: '127.0.0.1', port, method: req.method, path: req.path, headers }, (res) => {
					const chunks: Buffer[] = [];
					res.on('data', (c: Buffer) => chunks.push(c));
					res.on('end', () => resolve({ status: res.statusCode || 502, headers: res.headers as Headers, body: Buffer.concat(chunks) }));
					res.on('error', reject);
				});
				out.on('error', (e: NodeJS.ErrnoException) => {
					if (e.code === 'ECONNREFUSED') {
						const text = `Nothing is listening on localhost:${port} on the machine running this tunnel.\n`;
						resolve({ status: 502, headers: { 'content-type': 'text/plain; charset=utf-8' }, body: Buffer.from(text) });
					} else reject(e);
				});
				out.end(req.body.length ? Buffer.from(req.body) : undefined);
			});
		},

		upgrade(req, io) {
			const sock = net.connect({ host: '127.0.0.1', port });
			const head = [`GET ${req.path} HTTP/1.1`];
			for (const [k, v] of Object.entries(toLocal(req.headers, port, { upgrade: true }))) {
				for (const value of Array.isArray(v) ? v : [v]) head.push(`${k}: ${value}`);
			}
			sock.write(head.join('\r\n') + '\r\n\r\n');
			sock.on('data', (chunk: Buffer) => io.send(chunk));
			sock.on('close', () => io.close());
			sock.on('error', () => sock.destroy());
			return {
				write: (bytes) => sock.write(bytes),
				close: () => sock.destroy(),
			};
		},
	};
}

const USAGE = `Usage: lifo-sh tunnel <port> [--name <name>] [--base-url <url> | --local]

Put a server running on this machine on a public URL.

  lifo-sh tunnel 5173                https://<random>-tunnel.lifo.sh -> localhost:5173
  lifo-sh tunnel 3000 --name demo    https://demo-tunnel.lifo.sh     -> localhost:3000

Needs \`lifo-sh login\`. Ctrl+C stops it.`;

export async function handleTunnel(args: string[]): Promise<void> {
	const { flag, rest } = takeBaseUrlFlag(args);
	let name: string | undefined;
	const positional: string[] = [];
	for (let i = 0; i < rest.length; i++) {
		const a = rest[i]!;
		if (a === '-h' || a === '--help') {
			console.log(USAGE);
			process.exit(0);
		}
		if ((a === '--name' || a === '-n') && rest[i + 1]) name = rest[++i];
		else if (a.startsWith('--name=')) name = a.slice('--name='.length);
		else positional.push(a);
	}
	const port = Number(positional[0]);
	if (!Number.isInteger(port) || port < 1 || port > 65535) {
		console.error(USAGE);
		process.exit(1);
	}

	const auth = await resolveHostAuth(flag);
	if (!auth.token) {
		console.error(`Not logged in to ${auth.baseUrl}. Run \`lifo-sh login${flag ? ` --base-url ${auth.baseUrl}` : ''}\` first.`);
		process.exit(1);
	}

	let tunnelUrl = process.env.LIFO_TUNNEL_URL;
	if (!tunnelUrl) {
		try {
			tunnelUrl = (await fetchCliConfig(auth.baseUrl)).tunnelUrl;
		} catch (e) {
			console.error(`Could not get the tunnel server from ${auth.baseUrl}: ${(e as Error).message}`);
			process.exit(1);
		}
	}

	const ac = new AbortController();
	process.on('SIGINT', () => ac.abort());
	process.on('SIGTERM', () => ac.abort());

	console.log(`Connecting to ${tunnelUrl}...`);
	const code = await runTunnel({
		url: tunnelUrl,
		token: auth.token,
		port,
		name,
		client: 'lifo-sh (host)',
		forwarder: createHostForwarder(port),
		signal: ac.signal,
		WebSocketImpl: WebSocket as unknown as typeof globalThis.WebSocket,
		onReady: ({ url }) => console.log(`\n  \x1b[32m●\x1b[0m ${url}  ->  localhost:${port}\n\n  Ctrl+C to stop.\n`),
		onRequest: (line) => process.stdout.write(`  ${line}`),
		onStatus: (line) => process.stderr.write(line),
	});
	process.exit(code);
}
