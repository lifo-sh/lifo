import { describe, it, expect } from 'vitest';
import { dispatchRequest, waitForPort, LIFO_HEADER } from '../../src/kernel/network/dispatch.js';
import { PortBridge } from '../../src/kernel/network/PortBridge.js';
import type { VirtualRequestHandler, VirtualResponse } from '../../src/kernel/index.js';

/** A handler that finishes asynchronously, like Express/Vite/Metro/tinbase do. */
function asyncHandler(body: string, delayMs = 10, statusCode = 200): VirtualRequestHandler {
  return (_req, res) => {
    res._donePromise = new Promise<void>((resolve) => {
      setTimeout(() => {
        res.statusCode = statusCode;
        res.headers['content-type'] = 'application/json';
        res.body = body;
        resolve();
      }, delayMs);
    });
  };
}

describe('dispatchRequest', () => {
  it('waits for an async handler instead of returning an empty 200', async () => {
    const registry = new Map<number, VirtualRequestHandler>([[3000, asyncHandler('{"ok":true}')]]);
    const res = await dispatchRequest(registry, 3000, { url: '/api' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('{"ok":true}');
    expect(new TextDecoder().decode(res.bodyBytes)).toBe('{"ok":true}');
  });

  it('returns a synchronous handler’s response', async () => {
    const registry = new Map<number, VirtualRequestHandler>([[3000, (_req, res) => {
      res.statusCode = 201;
      res.body = 'made';
    }]]);
    const res = await dispatchRequest(registry, 3000, { method: 'POST', url: '/x' });
    expect(res.statusCode).toBe(201);
    expect(res.body).toBe('made');
  });

  it('marks an unbound port 404 with x-lifo: no-server', async () => {
    const res = await dispatchRequest(new Map(), 9999, { url: '/' });
    expect(res.statusCode).toBe(404);
    expect(res.headers[LIFO_HEADER]).toBe('no-server');
  });

  it('times out with 504 and x-lifo: timeout', async () => {
    // Never resolves — the timeout is the only way out.
    const registry = new Map<number, VirtualRequestHandler>([[3000, (_req, res) => {
      res._donePromise = new Promise<void>(() => {});
    }]]);
    const res = await dispatchRequest(registry, 3000, { url: '/slow' }, { timeoutMs: 20 });
    expect(res.statusCode).toBe(504);
    expect(res.headers[LIFO_HEADER]).toBe('timeout');
  });

  it('turns a throwing handler into a 500 with x-lifo: handler-error', async () => {
    const registry = new Map<number, VirtualRequestHandler>([[3000, () => { throw new Error('boom'); }]]);
    const res = await dispatchRequest(registry, 3000, { url: '/' });
    expect(res.statusCode).toBe(500);
    expect(res.headers[LIFO_HEADER]).toBe('handler-error');
    expect(res.body).toContain('boom');
  });

  it('rejects a promise rejection from the handler as a 500', async () => {
    const registry = new Map<number, VirtualRequestHandler>([[3000, (_req, res) => {
      res._donePromise = Promise.reject(new Error('async boom'));
    }]]);
    const res = await dispatchRequest(registry, 3000, { url: '/' });
    expect(res.statusCode).toBe(500);
    expect(res.body).toContain('async boom');
  });

  it('preserves binary response bodies byte-for-byte', async () => {
    // 0x00 and 0xff survive bodyBytes but not a UTF-8 text round-trip.
    const bytes = new Uint8Array([0, 1, 2, 250, 251, 255]);
    const registry = new Map<number, VirtualRequestHandler>([[3000, (_req, res) => {
      res.bodyBytes = bytes;
    }]]);
    const res = await dispatchRequest(registry, 3000, { url: '/blob.wasm' });
    expect(Array.from(res.bodyBytes)).toEqual(Array.from(bytes));
  });

  it('passes a Uint8Array request body through as text', async () => {
    let seen = '';
    const registry = new Map<number, VirtualRequestHandler>([[3000, (req, res) => {
      seen = req.body;
      res.body = 'ok';
    }]]);
    await dispatchRequest(registry, 3000, {
      method: 'POST',
      url: '/',
      body: new TextEncoder().encode('{"a":1}'),
    });
    expect(seen).toBe('{"a":1}');
  });
});

describe('waitForPort', () => {
  it('resolves once the port appears', async () => {
    const registry = new Map<number, VirtualRequestHandler>();
    setTimeout(() => registry.set(3000, (_q, r) => { r.body = ''; }), 30);
    await expect(waitForPort(registry, 3000, { timeout: 1000, intervalMs: 5 })).resolves.toBeUndefined();
  });

  it('rejects when the port never binds', async () => {
    await expect(waitForPort(new Map(), 3000, { timeout: 30, intervalMs: 5 })).rejects.toThrow(/Timed out/);
  });
});

describe('PortBridge.handleRequest', () => {
  // Regression: this returned `virtualRes` straight after calling the handler,
  // so every async server answered with an empty 200. It is public API, so the
  // bug was reachable by any consumer that forwarded a port.
  it('waits for an async server rather than returning an empty 200', async () => {
    const registry = new Map<number, VirtualRequestHandler>([[3000, asyncHandler('{"real":"body"}')]]);
    const bridge = new PortBridge(registry);
    bridge.forward(3000);
    const real = bridge.getForwardedPorts().find((p) => p.virtual === 3000)!.real;

    const res = await bridge.handleRequest(real, 'GET', '/api', {}, '');
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('{"real":"body"}');
  });

  it('502s when the port is not forwarded', async () => {
    const bridge = new PortBridge(new Map());
    const res = await bridge.handleRequest(65000, 'GET', '/', {}, '');
    expect(res.statusCode).toBe(502);
  });
});
