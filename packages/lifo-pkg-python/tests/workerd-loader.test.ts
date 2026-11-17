import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { checkedFetch, loadFromSource, PYODIDE_VERSION } from '../src/runtime.js';

// The loader used in workerd (Lifo Cloud), where a module can't be import()ed from a URL: it
// fetches Pyodide's scripts and evaluates them. Here the "CDN" is the pyodide npm package on disk
// so a Pyodide upgrade that breaks the loader's assumptions fails this test rather than a cloud box.
const dir = createRequire(import.meta.url).resolve('pyodide').replace(/[^/]+$/, '');
const BASE = 'https://pyodide.test/full/';
const realFetch = globalThis.fetch;

function serveFromDisk() {
  const seen: { url: string; integrity?: string }[] = [];
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    seen.push({ url, integrity: init?.integrity });
    if (init?.integrity) throw new TypeError('Subrequest integrity checking is not implemented.');
    if (!url.startsWith(BASE)) return realFetch(input, init);
    try {
      return new Response(readFileSync(dir + url.slice(BASE.length)));
    } catch {
      return new Response('not found', { status: 404 });
    }
  });
  return seen;
}

afterEach(() => vi.unstubAllGlobals());

describe('loading Pyodide from source (workerd)', () => {
  // Running the interpreter this way needs workerd itself (cloud/bench/python.mjs does that);
  // this checks the part that can drift: that both scripts still have the shape the loader edits.
  it('turns both fetched scripts into functions', async () => {
    vi.stubGlobal('navigator', { userAgent: 'Cloudflare-Workers' }); // Pyodide checks where it is on load
    const seen = serveFromDisk();
    const { loadPyodide, indexURL } = await loadFromSource(BASE);
    expect(indexURL).toBe(BASE);
    expect(typeof loadPyodide).toBe('function');
    expect(seen.map((s) => s.url.slice(BASE.length)).sort()).toEqual(['pyodide.asm.mjs', 'pyodide.mjs']);
  });

  it('says so when a script is not what it expects', async () => {
    vi.stubGlobal('fetch', async () => new Response('export const nothing = 1;'));
    await expect(loadFromSource(BASE)).rejects.toThrow(`Pyodide ${PYODIDE_VERSION} doesn't look as expected`);
  });
});

describe('checkedFetch', () => {
  const body = new TextEncoder().encode('wheel bytes');
  const sri = `sha256-${createHash('sha256').update(body).digest('base64')}`;

  it('checks integrity itself and never passes the option to fetch', async () => {
    const calls: (RequestInit | undefined)[] = [];
    vi.stubGlobal('fetch', async (_: unknown, init?: RequestInit) => (calls.push(init), new Response(body)));
    const res = await checkedFetch('https://x.test/a.whl', { integrity: sri });
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(body);
    expect(calls[0]).toEqual({});
  });

  it('rejects a body that does not match', async () => {
    vi.stubGlobal('fetch', async () => new Response('tampered'));
    await expect(checkedFetch('https://x.test/a.whl', { integrity: sri })).rejects.toThrow(/integrity/);
  });
});
