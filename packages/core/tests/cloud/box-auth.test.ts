import { afterEach, describe, expect, it, vi } from 'vitest';
import { Sandbox } from '../../src/sandbox/Sandbox.js';
import { pageAuth, tokenExpiry } from '../../src/cloud/box-auth.js';

const PAGE = 'https://site.test';

function tabToken(email: string, exp = Date.now() + 3600_000): string {
	const payload = Buffer.from(JSON.stringify({ u: 'u1', e: email, exp })).toString('base64url');
	return `lifo_tab_${payload}.sig`;
}

/** /api/me that knows a few tokens, recording which ones it was asked about. */
function stubMe(tokens: Record<string, string>): string[] {
	const seen: string[] = [];
	vi.stubGlobal('fetch', async (input: string | URL, init: RequestInit = {}) => {
		const url = new URL(String(input));
		const token = new Headers(init.headers).get('authorization')?.replace('Bearer ', '') ?? '';
		seen.push(`${url.origin} ${token}`);
		if (url.pathname !== '/api/me') return new Response('{}', { status: 404 });
		const email = tokens[token];
		return email ? Response.json({ email }) : Response.json({ error: 'Invalid token' }, { status: 401 });
	});
	return seen;
}

afterEach(() => vi.unstubAllGlobals());

describe('Sandbox auth (a page lends its login)', () => {
	it('asks for the token only when a lifo command needs it, and never puts it in env or files', async () => {
		const token = tabToken('page@x.com');
		stubMe({ [token]: 'page@x.com' });
		const getToken = vi.fn(async () => token);
		const box = await Sandbox.create({ auth: { baseUrl: PAGE, getToken } });

		await box.commands.run('ls; echo hi');
		expect(getToken).not.toHaveBeenCalled();

		const who = await box.commands.run('lifo whoami');
		expect(who.stdout.trim()).toBe(`page@x.com (${PAGE}, from this page's login)`);
		await box.commands.run('lifo whoami');
		expect(getToken).toHaveBeenCalledTimes(1); // cached

		const env = await box.commands.run('env');
		expect(env.stdout).toContain('HOME=');
		expect(env.stdout).not.toContain('lifo_tab_');
		expect(await box.fs.exists('/home/user/.lifo/auth.json')).toBe(false);
		const snap = await box.exportSnapshot();
		expect(Buffer.from(snap).toString('latin1')).not.toContain('lifo_tab_');
		box.destroy();
	});

	it('the page login beats LIFO_AUTH_TOKEN; --base-url elsewhere uses the other logins', async () => {
		const token = tabToken('page@x.com');
		const seen = stubMe({ [token]: 'page@x.com', lifo_env: 'env@x.com' });
		const box = await Sandbox.create({
			env: { LIFO_AUTH_TOKEN: 'lifo_env', LIFO_BASE_URL: 'https://other.test' },
			auth: { baseUrl: PAGE, getToken: async () => token },
		});
		expect((await box.commands.run('lifo whoami')).stdout).toContain('page@x.com');
		expect((await box.commands.run('lifo whoami --base-url https://other.test')).stdout.trim()).toBe('env@x.com (https://other.test)');
		expect(seen).toEqual([`${PAGE} ${token}`, 'https://other.test lifo_env']);
		box.destroy();
	});

	it('a logged-out page falls back to the box own login, and login/logout explain the page login', async () => {
		stubMe({ lifo_saved: 'saved@x.com' });
		let token: string | null = null;
		const box = await Sandbox.create({ auth: { baseUrl: PAGE, getToken: async () => token } });
		await box.fs.mkdir('/home/user/.lifo', { recursive: true });
		await box.fs.writeFile('/home/user/.lifo/auth.json', JSON.stringify({ current: PAGE, sessions: { [PAGE]: { token: 'lifo_saved', email: 'saved@x.com', savedAt: '' } } }));
		expect((await box.commands.run('lifo whoami')).stdout.trim()).toBe(`saved@x.com (${PAGE})`);
		box.destroy();

		token = tabToken('page@x.com');
		stubMe({ [token]: 'page@x.com' });
		const box2 = await Sandbox.create({ auth: { baseUrl: PAGE, getToken: async () => token } });
		expect((await box2.commands.run('lifo logout')).stdout).toContain('from the page');
		expect((await box2.commands.run('lifo login')).stdout).toContain('already uses your login');
		box2.destroy();
	});

	it('fetches a new token a minute before the old one expires', async () => {
		vi.useFakeTimers({ toFake: ['Date'] });
		try {
			const t1 = tabToken('a@x.com', Date.now() + 120_000);
			const t2 = tabToken('a@x.com', Date.now() + 3600_000);
			stubMe({ [t1]: 'a@x.com', [t2]: 'a@x.com' });
			const getToken = vi.fn().mockResolvedValueOnce(t1).mockResolvedValueOnce(t2);
			const box = await Sandbox.create({ auth: { baseUrl: PAGE, getToken } });
			await box.commands.run('lifo whoami');
			vi.setSystemTime(Date.now() + 30_000);
			await box.commands.run('lifo whoami');
			expect(getToken).toHaveBeenCalledTimes(1);
			vi.setSystemTime(Date.now() + 40_000); // within a minute of t1's exp
			await box.commands.run('lifo whoami');
			expect(getToken).toHaveBeenCalledTimes(2);
			box.destroy();
		} finally {
			vi.useRealTimers();
		}
	});
});

describe('pageAuth', () => {
	it('POSTs to the endpoint with the page cookies and returns null when logged out', async () => {
		const calls: { url: string; init: RequestInit }[] = [];
		let status = 200;
		vi.stubGlobal('fetch', async (input: string | URL, init: RequestInit = {}) => {
			calls.push({ url: String(input), init });
			return status === 200 ? Response.json({ token: 'lifo_tab_x.y' }) : Response.json({ error: 'no' }, { status });
		});
		const auth = pageAuth(PAGE);
		expect(await auth.getToken()).toBe('lifo_tab_x.y');
		expect(calls[0].url).toBe(`${PAGE}/api/box-token`);
		expect(calls[0].init.method).toBe('POST');
		expect(calls[0].init.credentials).toBe('same-origin');
		status = 401;
		expect(await auth.getToken()).toBeNull();
		status = 404; // a site without the endpoint
		expect(await auth.getToken()).toBeNull();
	});

	it('reads a tab token expiry', () => {
		expect(tokenExpiry(tabToken('a@x.com', 1234))).toBe(1234);
		expect(tokenExpiry('lifo_abc')).toBeNull();
	});
});
