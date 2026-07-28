import { describe, it, expect, afterEach } from 'vitest';
import { startSession, freePort, type Session } from './helpers/session.js';

/**
 * `--expose` end to end: the host's own `fetch` reaching a server inside the box.
 * Nothing in the assertion path knows about Lifo, so if these pass, `curl` works.
 */
describe('lifo --expose', () => {
  let session: Session | undefined;

  afterEach(async () => {
    await session?.stop();
    session = undefined;
  });

  it('answers 404 with x-lifo: no-server before the in-VM server starts', async () => {
    // Binding early is deliberate: a request that arrives while a dev server is
    // still booting should get a status, not a refused connection.
    const hostPort = await freePort();
    session = await startSession({ expose: [`3000:${hostPort}`] });

    const res = await fetch(`http://127.0.0.1:${hostPort}/`);
    expect(res.status).toBe(404);
    expect(res.headers.get('x-lifo')).toBe('no-server');
  });

  it('forwards to an in-VM server once it is listening, on a DIFFERENT host port', async () => {
    const hostPort = await freePort();
    session = await startSession({ expose: [`3000:${hostPort}`] });

    const { writeFileSync } = await import('node:fs');
    writeFileSync(`${session.mountDir}/server.js`, `
      const http = require('http');
      http.createServer((req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ from: 'inside the box', url: req.url }));
      }).listen(3000, () => console.log('up'));
    `);
    await session.run('node /mnt/host/server.js &', 2500);

    // Poll: the server binds asynchronously inside the box.
    let body: unknown;
    for (let i = 0; i < 30; i++) {
      const res = await fetch(`http://127.0.0.1:${hostPort}/hello`);
      if (res.status === 200) { body = await res.json(); break; }
      await new Promise((r) => setTimeout(r, 500));
    }
    expect(body).toEqual({ from: 'inside the box', url: '/hello' });
  });

  it('reports each mapping on startup', async () => {
    const a = await freePort();
    const b = await freePort();
    session = await startSession({ expose: [`3000:${a}`, `4000:${b}`] });

    const output = session.stderr();
    expect(output).toContain(`Exposed in-VM port 3000 at http://127.0.0.1:${a}`);
    expect(output).toContain(`Exposed in-VM port 4000 at http://127.0.0.1:${b}`);
  });

  it('keeps the session alive when a mapping cannot bind', async () => {
    // Hold a port so the forwarder fails on it, then check the box still boots:
    // losing one forward should not cost you the VM.
    const taken = await freePort();
    const net = await import('node:net');
    const blocker = net.createServer();
    await new Promise<void>((resolve) => blocker.listen(taken, '127.0.0.1', () => resolve()));

    try {
      const ok = await freePort();
      session = await startSession({ expose: [`3000:${taken}`, `4000:${ok}`] });

      expect(session.alive()).toBe(true);
      expect(session.stderr()).toMatch(/could not expose 3000/);
      // …and the mapping that could bind still works.
      const res = await fetch(`http://127.0.0.1:${ok}/`);
      expect(res.headers.get('x-lifo')).toBe('no-server');
      expect(await session.run('echo still-here')).toContain('still-here');
    } finally {
      await new Promise<void>((resolve) => blocker.close(() => resolve()));
    }
  });
});
