/**
 * A box's borrowed login: the account of the page (or app) that created it.
 *
 * `Sandbox.create({ auth })` hands a box a way to get a token, not the token itself. The in-box
 * `lifo login | whoami | tunnel | cloud` commands ask for one the first time they need it, and the
 * box caches it until shortly before it expires. It never goes into the box's environment or
 * files, so `printenv`, `cat ~/.lifo/auth.json` and a pushed snapshot don't contain it. Code
 * running in the box shares the page's JavaScript realm, though, so it isn't a secret from that
 * code (see docs/understand/security.md); websites should hand out short-lived tokens (lifo.sh's
 * `/api/box-token` gives 1-hour `lifo_tab_` tokens).
 */

import type { VFS } from '../kernel/vfs/index.js';
import { normalizeBaseUrl } from './auth.js';

export interface BoxAuth {
	/** The account server the token belongs to, e.g. https://lifo.sh. */
	baseUrl: string;
	/** Returns a `lifo_` token, or null when there's no login (logged out). Called lazily. */
	getToken: () => Promise<string | null>;
}

interface Slot {
	auth: BoxAuth;
	cached: { token: string | null; until: number } | null;
	pending: Promise<string | null> | null;
}

// Keyed by the box's VFS: every command in a box gets the same one, without threading the provider
// through each command's factory.
const slots = new WeakMap<VFS, Slot>();

const REFRESH_EARLY_MS = 60_000;
const NULL_RETRY_MS = 15_000; // a logged-out answer is asked again after this (they may log in)
const FALLBACK_TTL_MS = 5 * 60_000; // tokens whose expiry we can't read

/**
 * Lend a box (by its VFS) a login, for shells built on a kernel without Sandbox.create. Setting
 * the same provider again keeps its cached token.
 */
export function setBoxAuth(vfs: VFS, auth: BoxAuth | undefined): void {
	const cur = slots.get(vfs);
	if (auth && cur && cur.auth.getToken === auth.getToken && cur.auth.baseUrl === normalizeBaseUrl(auth.baseUrl)) return;
	if (auth) slots.set(vfs, { auth: { ...auth, baseUrl: normalizeBaseUrl(auth.baseUrl) }, cached: null, pending: null });
	else slots.delete(vfs);
}

export function hasBoxAuth(vfs: VFS): boolean {
	return slots.has(vfs);
}

/** The provider's base URL, or null when the box has none. */
export function boxAuthBaseUrl(vfs: VFS): string | null {
	return slots.get(vfs)?.auth.baseUrl ?? null;
}

/** When a `lifo_tab_` token expires (ms), from its payload; null for other tokens. */
export function tokenExpiry(token: string): number | null {
	const m = /^lifo_tab_([A-Za-z0-9_-]+)\./.exec(token);
	if (!m) return null;
	try {
		const b64 = m[1].replace(/-/g, '+').replace(/_/g, '/');
		const json = typeof atob === 'function' ? atob(b64) : Buffer.from(b64, 'base64').toString('binary');
		const exp = JSON.parse(json).exp;
		return typeof exp === 'number' ? exp : null;
	} catch {
		return null;
	}
}

/** The box's borrowed token: fetched on first use, reused until a minute before it expires. */
export async function getBoxAuthToken(vfs: VFS): Promise<string | null> {
	const slot = slots.get(vfs);
	if (!slot) return null;
	const now = Date.now();
	if (slot.cached && now < slot.cached.until) return slot.cached.token;
	if (!slot.pending) {
		slot.pending = (async () => {
			let token: string | null = null;
			try {
				token = (await slot.auth.getToken()) || null;
			} catch {
				token = null;
			}
			const exp = token ? tokenExpiry(token) : null;
			const until = !token ? Date.now() + NULL_RETRY_MS : exp ? exp - REFRESH_EARLY_MS : Date.now() + FALLBACK_TTL_MS;
			slot.cached = { token, until };
			return token;
		})().finally(() => {
			slot.pending = null;
		});
	}
	return slot.pending;
}

/** Forget the cached token, e.g. after the server refused it. */
export function clearBoxAuthToken(vfs: VFS): void {
	const slot = slots.get(vfs);
	if (slot) slot.cached = null;
}

/**
 * A BoxAuth for a box on a website that issues tokens to its logged-in visitors, e.g.
 * `Sandbox.create({ auth: pageAuth(location.origin) })` on lifo.sh. Asks `endpoint` (POST, with
 * the page's cookies) and returns null when the visitor isn't logged in or the site has no such
 * endpoint.
 */
export function pageAuth(baseUrl: string, endpoint = '/api/box-token'): BoxAuth {
	const url = new URL(endpoint, baseUrl).toString();
	return {
		baseUrl,
		async getToken() {
			try {
				const res = await fetch(url, { method: 'POST', credentials: 'same-origin', headers: { accept: 'application/json' } });
				if (!res.ok) return null;
				const body = (await res.json()) as { token?: unknown };
				return typeof body.token === 'string' && body.token.startsWith('lifo_') ? body.token : null;
			} catch {
				return null;
			}
		},
	};
}
