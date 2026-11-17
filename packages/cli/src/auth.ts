/**
 * auth.ts — `lifo-sh login | logout | whoami` on the host.
 *
 * Login works like Claude Code's: we listen on a random loopback port, open
 * <base>/cli/login in the browser, and the website redirects back to us with a
 * one-time code once the user approves. The code plus our PKCE verifier buys a
 * revocable `lifo_` key. If the browser can't reach us (SSH, a remote box), the
 * page shows the code instead and the user pastes it here; we accept whichever
 * arrives first.
 *
 * Credentials: ~/.lifo/auth.json, one session per website (lifo.sh, localhost:3000,
 * ...), plus `current`, the website commands use when no --base-url is given.
 * The pre-0.11 ~/.lifo-token still counts as a lifo.sh login.
 */

import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import * as readline from 'node:readline';
import { spawn } from 'node:child_process';
import { webcrypto } from 'node:crypto';
import {
	DEFAULT_BASE_URL,
	createPkce,
	exchangeCode,
	fetchMe,
	loadAuth,
	loginUrl,
	normalizeBaseUrl,
	removeSession,
	resolveBaseUrl,
	revokeToken,
	saveSession,
	type AuthStore,
} from '@lifo-sh/core';

// Node 18 has Web Crypto, but only on globalThis from Node 19 on.
(globalThis as { crypto?: unknown }).crypto ??= webcrypto;

export const LIFO_DIR = path.join(os.homedir(), '.lifo');
export const AUTH_PATH = path.join(LIFO_DIR, 'auth.json');
/** pre-0.11 login: a bare lifo.sh key. */
const LEGACY_TOKEN_PATH = path.join(os.homedir(), '.lifo-token');

export const hostStore: AuthStore = {
	async read() {
		try {
			return fs.readFileSync(AUTH_PATH, 'utf8');
		} catch {
			return null;
		}
	},
	async write(data) {
		fs.mkdirSync(LIFO_DIR, { recursive: true, mode: 0o700 });
		fs.writeFileSync(AUTH_PATH, data, { mode: 0o600 });
	},
};

/** Pulls `--base-url <url>`, `--base-url=<url>` and `--local` out of args. */
export function takeBaseUrlFlag(args: string[]): { flag?: string; rest: string[] } {
	const rest: string[] = [];
	let flag: string | undefined;
	for (let i = 0; i < args.length; i++) {
		const a = args[i]!;
		if (a === '--base-url' && args[i + 1]) flag = args[++i];
		else if (a.startsWith('--base-url=')) flag = a.slice('--base-url='.length);
		else if (a === '--local') flag = 'http://localhost:3000';
		else rest.push(a);
	}
	return { flag, rest };
}

function envBaseUrl(): string | undefined {
	if (process.env.LIFO_BASE_URL) return process.env.LIFO_BASE_URL;
	// `pnpm dev:cli` runs with NODE_ENV=development: talk to the local website.
	if (process.env.NODE_ENV === 'development') return 'http://localhost:3000';
	return undefined;
}

export interface HostAuth {
	baseUrl: string;
	token: string | null;
	email: string | null;
}

/** Which website to talk to, and the saved login for it. */
export async function resolveHostAuth(flag?: string): Promise<HostAuth> {
	const file = await loadAuth(hostStore);
	const baseUrl = resolveBaseUrl({ flag, env: envBaseUrl(), file });
	const s = file.sessions[baseUrl];
	if (s) return { baseUrl, token: s.token, email: s.email };
	if (baseUrl === DEFAULT_BASE_URL) {
		try {
			const legacy = fs.readFileSync(LEGACY_TOKEN_PATH, 'utf8').trim();
			if (legacy) return { baseUrl, token: legacy, email: null };
		} catch {
			/* no legacy login */
		}
	}
	return { baseUrl, token: null, email: null };
}

function link(url: string): string {
	return `\x1b]8;;${url}\x1b\\\x1b[34m${url}\x1b[0m\x1b]8;;\x1b\\`;
}

function openBrowser(url: string): boolean {
	if (process.env.LIFO_NO_BROWSER || process.env.SSH_CONNECTION) return false;
	const [cmd, args] =
		process.platform === 'darwin' ? ['open', [url]] :
		process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] :
		['xdg-open', [url]];
	try {
		const child = spawn(cmd, args as string[], { stdio: 'ignore', detached: true });
		child.on('error', () => {});
		child.unref();
		return true;
	} catch {
		return false;
	}
}

/** Waits for the browser to hit http://127.0.0.1:<port>/callback?code&state. */
function startLoopback(state: string, doneUrl: string): Promise<{ port: number; code: Promise<string>; close(): void }> {
	return new Promise((resolve, reject) => {
		let deliver!: (code: string) => void;
		const code = new Promise<string>((r) => (deliver = r));
		const server = http.createServer((req, res) => {
			const u = new URL(req.url || '/', 'http://127.0.0.1');
			if (u.pathname !== '/callback') {
				res.writeHead(404).end();
				return;
			}
			const c = u.searchParams.get('code');
			if (!c || u.searchParams.get('state') !== state) {
				res.writeHead(400, { 'content-type': 'text/plain' }).end('This login link does not match the waiting terminal. Run `lifo login` again.');
				return;
			}
			res.writeHead(302, { location: doneUrl }).end();
			deliver(c);
		});
		server.on('error', reject);
		server.listen(0, '127.0.0.1', () => {
			const port = (server.address() as { port: number }).port;
			resolve({ port, code, close: () => server.close() });
		});
	});
}

function promptLine(question: string): { answer: Promise<string>; close(): void } {
	const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: false });
	process.stdout.write(question);
	const answer = new Promise<string>((resolve) => rl.once('line', (line) => resolve(line.trim())));
	return { answer, close: () => rl.close() };
}

export async function handleLogin(args: string[] = []): Promise<void> {
	const { flag } = takeBaseUrlFlag(args);
	const noBrowser = args.includes('--no-browser');
	const auth = await resolveHostAuth(flag);

	if (auth.token) {
		const me = await fetchMe(auth.baseUrl, auth.token).catch(() => null);
		if (me) {
			// Make this website the default even if nothing changes, so `lifo login --local` sticks.
			await saveSession(hostStore, auth.baseUrl, { token: auth.token, email: me.email, savedAt: new Date().toISOString() });
			console.log(`Already logged in to ${auth.baseUrl} as ${me.email}. Run \`lifo-sh logout\` to switch accounts.`);
			process.exit(0);
		}
	}

	const pkce = await createPkce();
	const client = `lifo-sh on ${os.hostname()}`;
	let loopback: Awaited<ReturnType<typeof startLoopback>> | null = null;
	if (!noBrowser) {
		try {
			loopback = await startLoopback(pkce.state, new URL('/cli/login/done', auth.baseUrl).toString());
		} catch {
			loopback = null;
		}
	}

	const url = loginUrl(auth.baseUrl, { challenge: pkce.challenge, state: pkce.state, client, port: loopback?.port });
	const opened = !noBrowser && openBrowser(url);
	console.log(opened ? `Opening ${auth.baseUrl} in your browser to log in...` : `Log in to ${auth.baseUrl}:`);
	console.log(`\n  ${link(url)}\n`);

	// Whichever comes first: the browser's redirect, or a code pasted here.
	const pasteUrl = loginUrl(auth.baseUrl, { challenge: pkce.challenge, state: pkce.state, client });
	const prompt = promptLine(
		loopback
			? `Waiting for the browser... (no browser here? open ${pasteUrl}\nand paste the code it shows): `
			: 'Approve the login, then paste the code shown on the page: ',
	);
	const code = await Promise.race([loopback ? loopback.code : new Promise<string>(() => {}), prompt.answer]);
	prompt.close();
	loopback?.close();

	if (!code) {
		console.error('\nNo code entered.');
		process.exit(1);
	}
	process.stdout.write('\n');
	try {
		const { token, email } = await exchangeCode(auth.baseUrl, { code, verifier: pkce.verifier, client });
		await saveSession(hostStore, auth.baseUrl, { token, email, savedAt: new Date().toISOString() });
		if (auth.baseUrl === DEFAULT_BASE_URL) fs.rmSync(LEGACY_TOKEN_PATH, { force: true });
		console.log(`Logged in to ${auth.baseUrl} as ${email}. Saved to ~/.lifo/auth.json`);
		process.exit(0);
	} catch (e) {
		console.error(`Login failed: ${(e as Error).message}`);
		process.exit(1);
	}
}

export async function handleLogout(args: string[] = []): Promise<void> {
	const { flag } = takeBaseUrlFlag(args);
	const auth = await resolveHostAuth(flag);
	if (!auth.token) {
		console.log(`Not logged in to ${auth.baseUrl}.`);
		process.exit(0);
	}
	const revoked = await revokeToken(auth.baseUrl, auth.token);
	await removeSession(hostStore, auth.baseUrl);
	if (auth.baseUrl === DEFAULT_BASE_URL) fs.rmSync(LEGACY_TOKEN_PATH, { force: true });
	console.log(
		revoked
			? `Logged out of ${auth.baseUrl}. The key is revoked.`
			: `Logged out of ${auth.baseUrl}. Could not reach it to revoke the key; remove it under API keys on the dashboard.`,
	);
	process.exit(0);
}

export async function handleWhoami(args: string[] = []): Promise<void> {
	const { flag } = takeBaseUrlFlag(args);
	const auth = await resolveHostAuth(flag);
	if (!auth.token) {
		console.log(`Not logged in to ${auth.baseUrl}. Run \`lifo-sh login\`.`);
		process.exit(1);
	}
	try {
		const me = await fetchMe(auth.baseUrl, auth.token);
		if (!me) {
			console.log(`The saved key for ${auth.baseUrl} is no longer valid. Run \`lifo-sh login\`.`);
			process.exit(1);
		}
		console.log(`${me.email} (${auth.baseUrl})`);
		process.exit(0);
	} catch (e) {
		console.log(`Could not reach ${auth.baseUrl}: ${(e as Error).message}`);
		process.exit(1);
	}
}

/** Env for a box this CLI boots, so `lifo tunnel` etc. inside it use the host's login. */
export async function boxAuthEnv(): Promise<Record<string, string>> {
	const auth = await resolveHostAuth();
	const env: Record<string, string> = { LIFO_BASE_URL: normalizeBaseUrl(auth.baseUrl) };
	if (auth.token) env.LIFO_AUTH_TOKEN = auth.token;
	return env;
}
