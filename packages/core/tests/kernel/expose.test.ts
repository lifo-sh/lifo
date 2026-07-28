import { describe, it, expect, afterEach } from 'vitest';
import * as http from 'node:http';
import { Sandbox } from '../../src/sandbox/index.js';
import { exposePort, type ExposedPort } from '../../src/kernel/network/expose.js';
import { LIFO_HEADER } from '../../src/kernel/network/dispatch.js';

/**
 * `exposePort` publishes an in-VM port on a REAL host port, so these tests use
 * the host's own `fetch` and `ws` — nothing in the assertion path knows about
 * Lifo. If these pass, `curl` works.
 */
const SERVER = `const http = require('http');
const { WebSocketServer } = require('ws');

const server = http.createServer((req, res) => {
  if (req.url === '/json') { res.writeHead(200, {'content-type':'application/json'}); return res.end(JSON.stringify({ from: 'inside the vm' })); }
  if (req.url === '/binary') { res.writeHead(200, {'content-type':'application/octet-stream'}); return res.end(Buffer.from([0,1,2,250,255])); }
  if (req.method === 'POST' && req.url === '/echo') {
    let body = '';
    req.on('data', (c) => { body += c.toString(); });
    req.on('end', () => { res.writeHead(201, {'content-type':'application/json'}); res.end(JSON.stringify({ got: body, len: req.headers['content-length'] || null })); });
    return;
  }
  res.writeHead(404, {'content-type':'text/plain'});
  res.end('nope');
});

const wss = new WebSocketServer({ server, path: '/ws' });
wss.on('connection', (ws) => {
  ws.send('greeting');
  ws.on('message', (data) => ws.send('echo:' + data.toString()));
});

server.listen(4600, () => console.log('listening'));
`;

async function bootBox(): Promise<Sandbox> {
  const sandbox = await Sandbox.create({ persist: false });
  await sandbox.fs.writeFile('/home/user/package.json', JSON.stringify({ name: 'e', dependencies: { ws: '^8.19.0' } }));
  await sandbox.fs.writeFile('/home/user/server.js', SERVER);
  const install = await sandbox.commands.run('npm install 2>&1 | tail -1', { cwd: '/home/user', timeout: 300_000 });
  if (install.exitCode !== 0) throw new Error('npm install failed: ' + install.stdout);
  sandbox.shell.execute('node server.js', { cwd: '/home/user', env: sandbox.env }).catch(() => {});
  await sandbox.waitForPort(4600, { timeout: 30_000 });
  return sandbox;
}

describe('exposePort', () => {
  let sandbox: Sandbox | undefined;
  let exposed: ExposedPort | undefined;

  afterEach(async () => {
    await exposed?.close();
    exposed = undefined;
    sandbox?.destroy();
    sandbox = undefined;
  });

  it('serves an in-VM server over a real host port', async () => {
    sandbox = await bootBox();
    exposed = await exposePort(sandbox.kernel.portRegistry, { vmPort: 4600, http });
    // The host's own fetch — no Lifo in the request path.
    const res = await fetch(`${exposed.url}/json`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ from: 'inside the vm' });
  }, 300_000);

  // vmPort and hostPort are independent: in-VM 4600 published on host 5137.
  it('maps an in-VM port to a DIFFERENT host port', async () => {
    sandbox = await bootBox();
    exposed = await exposePort(sandbox.kernel.portRegistry, { vmPort: 4600, hostPort: 5137, http });
    expect(exposed.hostPort).toBe(5137);
    expect(exposed.url).toBe('http://127.0.0.1:5137');

    const res = await fetch('http://127.0.0.1:5137/json');
    expect(await res.json()).toEqual({ from: 'inside the vm' });

    // Nothing is listening on the VM's own number on the host — the mapping is
    // the only route in.
    await expect(fetch('http://127.0.0.1:4600/json')).rejects.toThrow();
  }, 300_000);

  it('assigns a free port when none is given, and reports it', async () => {
    sandbox = await bootBox();
    exposed = await exposePort(sandbox.kernel.portRegistry, { vmPort: 4600, http });
    expect(exposed.hostPort).toBeGreaterThan(0);
    expect(exposed.url).toContain(String(exposed.hostPort));
  }, 300_000);

  it('forwards a POST body and its content-length', async () => {
    sandbox = await bootBox();
    exposed = await exposePort(sandbox.kernel.portRegistry, { vmPort: 4600, http });
    const res = await fetch(`${exposed.url}/echo`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ hi: 'there' }),
    });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ got: '{"hi":"there"}', len: '14' });
  }, 300_000);

  it('preserves a binary body byte-for-byte', async () => {
    sandbox = await bootBox();
    exposed = await exposePort(sandbox.kernel.portRegistry, { vmPort: 4600, http });
    const res = await fetch(`${exposed.url}/binary`);
    expect(Array.from(new Uint8Array(await res.arrayBuffer()))).toEqual([0, 1, 2, 250, 255]);
  }, 300_000);

  it('passes the app’s own 404 through unchanged', async () => {
    sandbox = await bootBox();
    exposed = await exposePort(sandbox.kernel.portRegistry, { vmPort: 4600, http });
    const res = await fetch(`${exposed.url}/missing`);
    expect(res.status).toBe(404);
    expect(await res.text()).toBe('nope');
    expect(res.headers.get(LIFO_HEADER)).toBeNull();
  }, 300_000);

  it('can be bound before the in-VM server exists, answering 404 + x-lifo until then', async () => {
    sandbox = await Sandbox.create({ persist: false });
    exposed = await exposePort(sandbox.kernel.portRegistry, { vmPort: 4699, http });
    const res = await fetch(`${exposed.url}/`);
    expect(res.status).toBe(404);
    expect(res.headers.get(LIFO_HEADER)).toBe('no-server');
  }, 60_000);

  it('proxies a WebSocket, letting the in-VM server do the handshake', async () => {
    sandbox = await bootBox();
    exposed = await exposePort(sandbox.kernel.portRegistry, { vmPort: 4600, http });

    // A real ws client against the host port — it must see a valid RFC 6455
    // handshake, which the in-VM server produced.
    const { WebSocket } = await import('ws');
    const client = new WebSocket(`ws://127.0.0.1:${exposed.hostPort}/ws`);
    const messages: string[] = [];
    await new Promise<void>((resolve, reject) => {
      client.on('message', (d: Buffer) => {
        messages.push(d.toString());
        if (messages.length === 2) resolve();
      });
      client.on('open', () => client.send('marco'));
      client.on('error', reject);
      setTimeout(() => reject(new Error('ws timed out; got ' + JSON.stringify(messages))), 20_000);
    });
    client.close();
    expect(messages[0]).toBe('greeting');
    expect(messages[1]).toBe('echo:marco');
  }, 300_000);

  it('rejects when the host port is already taken', async () => {
    sandbox = await Sandbox.create({ persist: false });
    exposed = await exposePort(sandbox.kernel.portRegistry, { vmPort: 4600, http });
    await expect(
      exposePort(sandbox.kernel.portRegistry, { vmPort: 4600, hostPort: exposed.hostPort, http }),
    ).rejects.toThrow(/EADDRINUSE|address already in use/i);
  }, 60_000);

  it('stops serving after close()', async () => {
    sandbox = await bootBox();
    const e = await exposePort(sandbox.kernel.portRegistry, { vmPort: 4600, http });
    const url = `${e.url}/json`;
    expect((await fetch(url)).status).toBe(200);
    await e.close();
    await expect(fetch(url)).rejects.toThrow();
  }, 300_000);
});
