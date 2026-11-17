/**
 * cloud/auth.ts — talking to lifo.sh (or a local website) as a signed-in user.
 *
 * Shared by the `lifo` command inside a box and by the host CLI (`npx lifo-sh`),
 * so it only uses what both a browser and Node 18+ have: fetch and Web Crypto.
 * Where credentials live is the caller's business (an AuthStore): the box keeps
 * them in its own filesystem, the host CLI in ~/.lifo/auth.json.
 *
 * Login is the browser flow Claude Code uses: the CLI makes a PKCE pair, the user
 * approves in the browser, and the website hands back a short-lived code that only
 * the holder of the verifier can turn into an API key. The key is an ordinary
 * revocable `lifo_` key (it shows up under API keys on the dashboard), and logout
 * revokes it on the server.
 */

export const DEFAULT_BASE_URL = 'https://lifo.sh';

export interface Session {
	token: string;
	email: string;
	savedAt: string;
}

/** ~/.lifo/auth.json: one session per website, plus the one commands use by default. */
export interface AuthFile {
	current?: string;
	sessions: Record<string, Session>;
}

export interface AuthStore {
	read(): Promise<string | null>;
	write(data: string): Promise<void>;
}

export function normalizeBaseUrl(url: string): string {
	const u = new URL(url.includes('://') ? url : `https://${url}`);
	if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error(`not an http(s) URL: ${url}`);
	return u.origin;
}

export async function loadAuth(store: AuthStore): Promise<AuthFile> {
	try {
		const raw = await store.read();
		if (!raw) return { sessions: {} };
		const parsed = JSON.parse(raw) as Partial<AuthFile>;
		return { current: parsed.current, sessions: parsed.sessions ?? {} };
	} catch {
		return { sessions: {} };
	}
}

/** `--base-url` beats LIFO_BASE_URL beats the website of the last login beats lifo.sh. */
export function resolveBaseUrl(opts: { flag?: string; env?: string; file?: AuthFile }): string {
	const pick = opts.flag || opts.env || opts.file?.current || DEFAULT_BASE_URL;
	return normalizeBaseUrl(pick);
}

export async function saveSession(store: AuthStore, baseUrl: string, session: Session): Promise<void> {
	const file = await loadAuth(store);
	file.sessions[baseUrl] = session;
	file.current = baseUrl;
	await store.write(JSON.stringify(file, null, 2) + '\n');
}

export async function removeSession(store: AuthStore, baseUrl: string): Promise<void> {
	const file = await loadAuth(store);
	delete file.sessions[baseUrl];
	await store.write(JSON.stringify(file, null, 2) + '\n');
}

// ─── PKCE ───

function base64url(bytes: Uint8Array): string {
	let bin = '';
	for (const b of bytes) bin += String.fromCharCode(b);
	return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function randomString(bytes = 32): string {
	const buf = new Uint8Array(bytes);
	globalThis.crypto.getRandomValues(buf);
	return base64url(buf);
}

export interface Pkce {
	verifier: string;
	challenge: string;
	state: string;
}

export async function createPkce(): Promise<Pkce> {
	const verifier = randomString(32);
	const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
	return { verifier, challenge: base64url(new Uint8Array(digest)), state: randomString(16) };
}

/**
 * The page the user approves the login on. With `port`, the website redirects the
 * browser to http://127.0.0.1:<port>/callback with the code; without it (SSH, or a
 * box running in a browser tab), the page shows the code to paste back.
 */
export function loginUrl(baseUrl: string, p: { challenge: string; state: string; client: string; port?: number }): string {
	const u = new URL('/cli/login', baseUrl);
	u.searchParams.set('challenge', p.challenge);
	u.searchParams.set('state', p.state);
	u.searchParams.set('client', p.client);
	if (p.port) u.searchParams.set('port', String(p.port));
	return u.toString();
}

async function errorText(res: Response): Promise<string> {
	try {
		const body = (await res.json()) as { error?: string };
		return body.error || `HTTP ${res.status}`;
	} catch {
		return `HTTP ${res.status}`;
	}
}

/** Trade the code from the browser (plus our verifier) for an API key. */
export async function exchangeCode(
	baseUrl: string,
	p: { code: string; verifier: string; client: string },
): Promise<{ token: string; email: string }> {
	const res = await fetch(new URL('/api/cli/token', baseUrl), {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ code: p.code.trim(), verifier: p.verifier, client: p.client }),
	});
	if (!res.ok) throw new Error(await errorText(res));
	return (await res.json()) as { token: string; email: string };
}

/** The signed-in user, or null if the key is unknown or revoked. Throws if the website can't be reached. */
export async function fetchMe(baseUrl: string, token: string): Promise<{ email: string } | null> {
	const res = await fetch(new URL('/api/me', baseUrl), { headers: { authorization: `Bearer ${token}` } });
	if (res.status === 401) return null;
	if (!res.ok) throw new Error(await errorText(res));
	return (await res.json()) as { email: string };
}

/** Revoke the key on the server. Best effort: logout still forgets it locally. */
export async function revokeToken(baseUrl: string, token: string): Promise<boolean> {
	try {
		const res = await fetch(new URL('/api/cli/token', baseUrl), {
			method: 'DELETE',
			headers: { authorization: `Bearer ${token}` },
		});
		return res.ok;
	} catch {
		return false;
	}
}

export interface CliConfig {
	/** WebSocket URL of the tunnel server, e.g. wss://tunnel.lifo.sh/_tunnel. */
	tunnelUrl: string;
	/** Lifo Cloud's API, or null where the cloud isn't offered. */
	cloudUrl?: string | null;
	/** Lifo services (tools that run on Lifo's servers), or null where they aren't offered. */
	servicesUrl?: string | null;
}

export async function fetchCliConfig(baseUrl: string): Promise<CliConfig> {
	const res = await fetch(new URL('/api/cli/config', baseUrl));
	if (!res.ok) throw new Error(`${baseUrl}/api/cli/config: ${await errorText(res)}`);
	return (await res.json()) as CliConfig;
}
