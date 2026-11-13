import http from 'node:http';
import zlib from 'node:zlib';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { browse, BrowseError, createRateLimiter, handleBrowseRequest } from '../src/proxy';

const fail = (p: Promise<unknown>) => p.then(() => null, (e: BrowseError) => ({ status: e.status, message: e.message }));

describe('browse: refused before connecting', () => {
  it.each([
    ['http://127.0.0.1/', 403],
    ['http://[::1]/', 403],
    ['http://169.254.169.254/latest/meta-data/', 403],
    ['http://10.0.0.1/', 403],
    ['http://2130706433/', 403], // 127.0.0.1 as one number; the URL parser normalizes it
    ['http://0x7f.1/', 403],
    ['http://[::ffff:127.0.0.1]/', 403],
    ['http://localhost/', 403],
    ['http://app.localhost/', 403],
    ['file:///etc/passwd', 400],
    ['ftp://example.com/', 400],
    ['http://user:pw@example.com/', 400],
    ['http://example.com:22/', 400],
    ['not a url', 400],
  ])('%s → %i', async (url, status) => {
    expect((await fail(browse(url)))?.status).toBe(status);
  });

  it('refuses a host name that resolves to a private address (checked inside the DNS lookup)', async () => {
    // localhost.localdomain-style names aren't caught by the literal check; "localtest.me" style
    // services aren't reliable offline, so use a name the system resolver maps to loopback.
    const r = await fail(browse('http://ip6-localhost/'));
    // Either the resolver doesn't know the name (502) or it maps to ::1 and is refused (403).
    expect([403, 502]).toContain(r?.status);
  });
});

describe('browse: against a local server', () => {
  let server: http.Server;
  let base: string;
  const loopbackOnly = { isAllowedAddress: (ip: string) => ip === '127.0.0.1', allowedPorts: [80] as number[] };

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      const u = new URL(req.url!, 'http://x');
      if (u.pathname === '/page') {
        if (req.headers.cookie) res.statusCode = 400;
        res.setHeader('set-cookie', 'a=b');
        res.setHeader('content-type', 'text/html; charset=utf-8');
        res.end(`<title>Hi</title><p>ua=${req.headers['user-agent']}</p>`);
      } else if (u.pathname === '/gzip') {
        res.setHeader('content-type', 'text/plain');
        res.setHeader('content-encoding', 'gzip');
        res.end(zlib.gzipSync('compressed hello'));
      } else if (u.pathname === '/big') {
        res.setHeader('content-type', 'text/plain');
        res.end('x'.repeat(5000));
      } else if (u.pathname === '/image') {
        res.setHeader('content-type', 'image/png');
        res.end('png');
      } else if (u.pathname === '/to-page') {
        res.writeHead(302, { location: '/page' }).end();
      } else if (u.pathname === '/to-metadata') {
        res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data/' }).end();
      } else if (u.pathname === '/to-localhost') {
        res.writeHead(301, { location: 'http://localhost/' }).end();
      } else if (u.pathname === '/loop') {
        res.writeHead(302, { location: '/loop' }).end();
      } else if (u.pathname === '/slow') {
        setTimeout(() => res.end('late'), 2000);
      } else res.writeHead(404, { 'content-type': 'text/html' }).end('<title>Nope</title>');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;
    loopbackOnly.allowedPorts.push(port);
    base = `http://127.0.0.1:${port}`;
  });
  afterAll(() => server.close());

  it('returns the page, with no cookies and a generic user agent', async () => {
    const r = await browse(`${base}/page`, loopbackOnly);
    expect(r.status).toBe(200);
    expect(r.contentType).toContain('text/html');
    expect(r.body).toContain('<title>Hi</title>');
    expect(r.body).toContain('LifoBrowser');
    expect(r).not.toHaveProperty('headers');
  });

  it('decompresses', async () => {
    expect((await browse(`${base}/gzip`, loopbackOnly)).body).toBe('compressed hello');
  });

  it('cuts big bodies', async () => {
    const r = await browse(`${base}/big`, { ...loopbackOnly, maxBytes: 1000 });
    expect(r.body.length).toBe(1000);
    expect(r.truncated).toBe(true);
  });

  it('refuses other content types', async () => {
    expect((await fail(browse(`${base}/image`, loopbackOnly)))?.status).toBe(415);
  });

  it('follows redirects and reports the final URL', async () => {
    const r = await browse(`${base}/to-page`, loopbackOnly);
    expect(r.url).toBe(`${base}/page`);
  });

  it('checks every redirect hop', async () => {
    expect((await fail(browse(`${base}/to-metadata`, loopbackOnly)))?.status).toBe(403);
    expect((await fail(browse(`${base}/to-localhost`, loopbackOnly)))?.status).toBe(403);
  });

  it('stops redirect loops', async () => {
    expect((await fail(browse(`${base}/loop`, loopbackOnly)))?.status).toBe(508);
  });

  it('times out', async () => {
    expect((await fail(browse(`${base}/slow`, { ...loopbackOnly, timeoutMs: 300 })))?.status).toBe(504);
  });

  it('passes upstream errors through as a status, not a failure', async () => {
    expect((await browse(`${base}/missing`, loopbackOnly)).status).toBe(404);
  });

  it('the default rules refuse this loopback server', async () => {
    expect((await fail(browse(`${base}/page`)))?.status).toBe(400); // its port isn't allowed either
    expect((await fail(browse(`${base}/page`, { allowedPorts: loopbackOnly.allowedPorts })))?.status).toBe(403);
  });
});

describe('handleBrowseRequest', () => {
  const req = (url: string, init?: RequestInit) => new Request(`http://site.test/api/browse${url}`, init);

  it('answers errors as JSON with a status', async () => {
    const r = await handleBrowseRequest(req('?url=http://127.0.0.1/'), { limiter: () => true });
    expect(r.status).toBe(403);
    expect(await r.json()).toEqual({ error: expect.stringContaining('127.0.0.1') });
  });

  it('needs ?url=', async () => {
    expect((await handleBrowseRequest(req(''), { limiter: () => true })).status).toBe(400);
  });

  it('is GET only', async () => {
    expect((await handleBrowseRequest(req('?url=x', { method: 'POST', body: 'x' }), { limiter: () => true })).status).toBe(405);
  });

  it('refuses cross-site callers', async () => {
    const r = await handleBrowseRequest(req('?url=x', { headers: { 'sec-fetch-site': 'cross-site' } }), { limiter: () => true });
    expect(r.status).toBe(403);
  });

  it('rate-limits per client', async () => {
    const limiter = createRateLimiter({ limit: 2, windowMs: 60_000 });
    const codes = [];
    for (let i = 0; i < 3; i++) codes.push((await handleBrowseRequest(req('?url=file:///x'), { limiter, clientKey: 'a' })).status);
    expect(codes).toEqual([400, 400, 429]);
    expect((await handleBrowseRequest(req('?url=file:///x'), { limiter, clientKey: 'b' })).status).toBe(400);
  });
});
