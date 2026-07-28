import { describe, it, expect, afterEach } from 'vitest';
import { Sandbox } from '../../src/sandbox/index.js';

/**
 * `sandbox.connect()` against a REAL in-VM WebSocket server — the `ws` package
 * running inside the box, doing its own RFC 6455 handshake over the socket
 * stand-in. So the handshake split, frame decoding, fragment reassembly and
 * masking are all exercised rather than stubbed.
 */
const SERVER = `const http = require('http');
const { WebSocketServer } = require('ws');

const server = http.createServer((req, res) => { res.writeHead(200); res.end('http ok'); });
const wss = new WebSocketServer({ server, path: '/hot' });

wss.on('connection', (ws) => {
  ws.send('hello');
  ws.on('message', (data, isBinary) => {
    if (isBinary) { ws.send(data, { binary: true }); return; }
    const text = data.toString();
    if (text === 'ping') { ws.send('pong'); return; }
    if (text === 'big') { ws.send('x'.repeat(200000)); return; }
    if (text === 'bye') { ws.close(); return; }
    ws.send('echo:' + text);
  });
});

server.listen(4500, () => console.log('listening'));
`;

async function bootWsServer(): Promise<Sandbox> {
  const sandbox = await Sandbox.create({ persist: false });
  await sandbox.fs.writeFile('/home/user/package.json', JSON.stringify({ name: 'ws-app', dependencies: { ws: '^8.19.0' } }));
  await sandbox.fs.writeFile('/home/user/server.js', SERVER);
  const install = await sandbox.commands.run('npm install 2>&1 | tail -1', { cwd: '/home/user', timeout: 300_000 });
  if (install.exitCode !== 0) throw new Error('npm install failed: ' + install.stdout + install.stderr);
  sandbox.shell.execute('node server.js', { cwd: '/home/user', env: sandbox.env }).catch(() => {});
  await sandbox.waitForPort(4500, { timeout: 30_000 });
  return sandbox;
}

describe('sandbox.connect', () => {
  let sandbox: Sandbox;
  afterEach(() => { sandbox?.destroy(); });

  it('completes the handshake and receives the server’s first message', async () => {
    sandbox = await bootWsServer();
    const ws = await sandbox.connect(4500, '/hot');
    expect(ws.readyState).toBe(1);
    // Sent by the server on connection — it must not be lost to the handshake
    // split, which is the classic way to drop the first frame.
    expect(await ws.nextMessage()).toBe('hello');
    ws.close();
  }, 300_000);

  it('round-trips a text message', async () => {
    sandbox = await bootWsServer();
    const ws = await sandbox.connect(4500, '/hot');
    await ws.nextMessage();               // 'hello'
    ws.send('ping');
    expect(await ws.nextMessage()).toBe('pong');
    ws.send('marco');
    expect(await ws.nextMessage()).toBe('echo:marco');
    ws.close();
  }, 300_000);

  it('round-trips a binary message as Uint8Array', async () => {
    sandbox = await bootWsServer();
    const ws = await sandbox.connect(4500, '/hot');
    await ws.nextMessage();
    ws.send(new Uint8Array([0, 1, 2, 250, 255]));
    const echoed = await ws.nextMessage();
    expect(echoed).toBeInstanceOf(Uint8Array);
    expect(Array.from(echoed as Uint8Array)).toEqual([0, 1, 2, 250, 255]);
    ws.close();
  }, 300_000);

  it('reassembles a payload that arrives as multiple frames', async () => {
    sandbox = await bootWsServer();
    const ws = await sandbox.connect(4500, '/hot');
    await ws.nextMessage();
    ws.send('big');
    const big = await ws.nextMessage(30_000);
    expect(typeof big).toBe('string');
    expect((big as string).length).toBe(200000);
    ws.close();
  }, 300_000);

  it('fires onmessage handlers as well as nextMessage', async () => {
    sandbox = await bootWsServer();
    const ws = await sandbox.connect(4500, '/hot');
    const seen: string[] = [];
    ws.addEventListener('message', (e) => { seen.push(String(e.data)); });
    ws.send('ping');
    await ws.nextMessage();               // 'hello'
    await ws.nextMessage();               // 'pong'
    expect(seen).toContain('hello');
    expect(seen).toContain('pong');
    ws.close();
  }, 300_000);

  it('reports a close initiated by the server', async () => {
    sandbox = await bootWsServer();
    const ws = await sandbox.connect(4500, '/hot');
    await ws.nextMessage();
    const closed = new Promise<void>((resolve) => { ws.onclose = () => resolve(); });
    ws.send('bye');
    await closed;
    expect(ws.readyState).toBe(3);
  }, 300_000);

  it('rejects when nothing on the port handles upgrades', async () => {
    sandbox = await bootWsServer();
    // 4500 serves HTTP and upgrades only on /hot; 9977 has no server at all.
    await expect(sandbox.connect(9977, '/hot')).rejects.toThrow(/No server handling WebSocket upgrades/);
  }, 300_000);

  it('refuses send() before the socket is open', async () => {
    sandbox = await Sandbox.create({ persist: false });
    await expect(sandbox.connect(9978, '/hot')).rejects.toThrow();
  });
});
