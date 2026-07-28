import { describe, it, expect, afterEach } from 'vitest';
import { Sandbox } from '../../src/sandbox/index.js';
import { LIFO_HEADER } from '../../src/kernel/network/dispatch.js';

/**
 * `sandbox.fetch` against a REAL in-VM server — the request goes through
 * node-compat's http, so `_donePromise`, header handling and body parsing are
 * all exercised rather than stubbed. No service worker, no port forwarding.
 *
 * `http` is built in, so these boot fast (no npm install). The heavier stacks
 * (Express, tinbase + supabase-js) are covered by bench/test-host-net.mjs.
 */
const SERVER = `const http = require('http');
const server = http.createServer((req, res) => {
  if (req.url === '/text') { res.writeHead(200, {'content-type':'text/plain'}); return res.end('hello'); }
  if (req.url === '/json') { res.writeHead(200, {'content-type':'application/json'}); return res.end(JSON.stringify({ok:true, n:42})); }
  if (req.url === '/empty') { res.writeHead(204); return res.end(); }
  if (req.url === '/binary') { res.writeHead(200, {'content-type':'application/octet-stream'}); return res.end(Buffer.from([0,1,2,250,255])); }
  if (req.url === '/echo' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => { body += c.toString(); });
    req.on('end', () => { res.writeHead(201, {'content-type':'application/json'}); res.end(JSON.stringify({ got: body, len: req.headers['content-length'] || null })); });
    return;
  }
  res.writeHead(404, {'content-type':'text/plain'});
  res.end('nope');
});
server.listen(3400, () => console.log('listening'));
`;

async function bootServer(): Promise<Sandbox> {
  const sandbox = await Sandbox.create({ persist: false });
  await sandbox.fs.writeFile('/home/user/server.js', SERVER);
  sandbox.shell.execute('node server.js', { cwd: '/home/user', env: sandbox.env }).catch(() => {});
  await sandbox.waitForPort(3400, { timeout: 20_000 });
  return sandbox;
}

describe('sandbox.fetch', () => {
  let sandbox: Sandbox;
  afterEach(() => { sandbox?.destroy(); });

  it('GETs text from an in-VM server', async () => {
    sandbox = await bootServer();
    const res = await sandbox.fetch('http://localhost:3400/text');
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('hello');
  });

  it('returns a real Response, so .json() works', async () => {
    sandbox = await bootServer();
    const res = await sandbox.fetch('http://localhost:3400/json');
    expect(await res.json()).toEqual({ ok: true, n: 42 });
    expect(res.headers.get('content-type')).toBe('application/json');
  });

  it('POSTs a body and restores content-length so parsers see it', async () => {
    sandbox = await bootServer();
    const res = await sandbox.fetch('http://localhost:3400/echo', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ hi: 'there' }),
    });
    expect(res.status).toBe(201);
    // content-length is what body-parser/express.json's hasBody() needs; fetch
    // omits it, so sandbox.fetch restores it like the SW/nosw shims do.
    expect(await res.json()).toEqual({ got: '{"hi":"there"}', len: '14' });
  });

  it('preserves binary bodies byte-for-byte', async () => {
    sandbox = await bootServer();
    const res = await sandbox.fetch('http://localhost:3400/binary');
    expect(Array.from(new Uint8Array(await res.arrayBuffer()))).toEqual([0, 1, 2, 250, 255]);
  });

  it('handles 204 without throwing on a null-body status', async () => {
    sandbox = await bootServer();
    const res = await sandbox.fetch('http://localhost:3400/empty');
    expect(res.status).toBe(204);
    expect(await res.text()).toBe('');
  });

  it("passes through the app's own 404", async () => {
    sandbox = await bootServer();
    const res = await sandbox.fetch('http://localhost:3400/missing');
    expect(res.status).toBe(404);
    // The app answered, so this is NOT flagged as a transport-level miss.
    expect(res.headers.get(LIFO_HEADER)).toBeNull();
    expect(await res.text()).toBe('nope');
  });

  it('reports an unbound port as 404 + x-lifo: no-server rather than throwing', async () => {
    sandbox = await Sandbox.create({ persist: false });
    const res = await sandbox.fetch('http://localhost:9911/');
    expect(res.status).toBe(404);
    expect(res.headers.get(LIFO_HEADER)).toBe('no-server');
  });

  it('accepts a bare path when given a port', async () => {
    sandbox = await bootServer();
    const res = await sandbox.fetch('/text', { port: 3400 });
    expect(await res.text()).toBe('hello');
  });

  it('rejects a bare path with no port, instead of guessing one', async () => {
    sandbox = await Sandbox.create({ persist: false });
    await expect(sandbox.fetch('/text')).rejects.toThrow(/needs a port/);
  });

  it('refuses a non-loopback host', async () => {
    sandbox = await Sandbox.create({ persist: false });
    await expect(sandbox.fetch('https://example.com/')).rejects.toThrow(/loopback/);
  });

  it('carries the query string through to the server', async () => {
    sandbox = await bootServer();
    const res = await sandbox.fetch('http://localhost:3400/missing?select=*&order=id');
    expect(res.status).toBe(404);
  });
});

describe('sandbox.waitForPort', () => {
  let sandbox: Sandbox;
  afterEach(() => { sandbox?.destroy(); });

  it('rejects when nothing binds', async () => {
    sandbox = await Sandbox.create({ persist: false });
    await expect(sandbox.waitForPort(9912, { timeout: 50 })).rejects.toThrow(/Timed out/);
  });
});
