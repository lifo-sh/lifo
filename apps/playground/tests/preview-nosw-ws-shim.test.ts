import { describe, it, expect, beforeEach } from 'vitest';
import { shimScript, routerShim } from '../src/lib/preview-nosw';

/**
 * The nosw preview runs the app inside a blob: iframe. In a blob document,
 * `window.location.host` is '' — so Metro builds its HMR socket as `ws:///hot`
 * (empty host, an invalid special-scheme URL). This test evaluates the injected
 * WebSocket shim against that blob-iframe environment and asserts it still
 * tunnels the empty-host socket to the preview port (regression for "no HMR on
 * nosw with real Metro"). See preview-nosw.ts LifoWS.
 */
const PORT = 8081;

function installShim() {
  const posted: Array<Record<string, unknown>> = [];
  const parentWin = { postMessage: (m: Record<string, unknown>) => posted.push(m) };
  const FakeNode = function () {} as unknown as { prototype: Record<string, unknown> };
  FakeNode.prototype.appendChild = function (n: unknown) { return n; };
  FakeNode.prototype.insertBefore = function (n: unknown) { return n; };

  const window: Record<string, unknown> = {
    parent: parentWin,
    addEventListener: () => {},
    // blob: iframe — host/hostname/port are all empty; only origin is populated.
    HTMLImageElement: undefined,
    FontFace: undefined,
    XMLHttpRequest: undefined,
    fetch: () => Promise.resolve(),
  };
  const OrigWS = class NativeWS { constructor(public url: string, public protocols?: unknown) {} };
  window.WebSocket = OrigWS;
  const location = { href: 'blob:http://localhost:5173/uuid-1234', host: '', hostname: '', port: '', origin: 'http://localhost:5173', protocol: 'blob:' };

  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  new Function('window', 'location', 'Node', 'URL', 'Map', 'TextEncoder', 'TextDecoder', 'btoa', 'atob',
    shimScript(PORT),
  )(window, location, FakeNode, URL, Map, TextEncoder, TextDecoder, btoa, atob);

  return { WebSocket: window.WebSocket as new (url: string, p?: unknown) => Record<string, unknown>, posted, OrigWS };
}

describe('preview-nosw ws shim (blob iframe)', () => {
  let env: ReturnType<typeof installShim>;
  beforeEach(() => { env = installShim(); });

  it('tunnels Metro empty-host HMR socket ws:///hot to the preview port', () => {
    const ws = new env.WebSocket('ws:///hot') as Record<string, unknown> & { connId: string };
    expect(ws instanceof (env.OrigWS as never)).toBe(false);
    const open = env.posted.find((m) => m.type === 'ws-open');
    expect(open).toBeTruthy();
    expect(open!.url).toBe('/hot');
    expect(open!.port).toBe(PORT);
  });

  it('tunnels the empty-host /message socket too', () => {
    const ws = new env.WebSocket('ws:///message') as Record<string, unknown> & { connId: string };
    expect(ws instanceof (env.OrigWS as never)).toBe(false);
    const open = env.posted.find((m) => m.type === 'ws-open');
    expect(open!.url).toBe('/message');
  });

  it('still tunnels an explicit localhost:PORT socket', () => {
    new env.WebSocket(`ws://localhost:${PORT}/hot?x=1`);
    const open = env.posted.find((m) => m.type === 'ws-open');
    expect(open!.url).toBe('/hot?x=1');
    expect(open!.port).toBe(PORT);
  });

  it('leaves genuinely cross-origin sockets on the native implementation', () => {
    const ws = new env.WebSocket('wss://example.com/socket');
    expect(ws instanceof (env.OrigWS as never)).toBe(true);
    expect(env.posted.find((m) => m.type === 'ws-open')).toBeUndefined();
  });
});

/**
 * Metro derives its HMR entry point from document.currentScript.src (the bundle
 * blob in nosw). The router shim must map that blob back to the real bundle URL,
 * or register-entrypoints sends an unmatched blob: URL and no updates are pushed.
 */
describe('preview-nosw router shim (bundle url mapping)', () => {
  function evalRouterShim(bundleBlob: string, realBundlePath: string) {
    const window: Record<string, unknown> = {};
    const history: Record<string, unknown> = { replaceState: () => {}, pushState: () => {}, go: () => {}, back: () => {}, forward: () => {}, state: null };
    const location = { hash: '', origin: 'http://localhost:5173', href: 'blob:http://localhost:5173/doc-uuid' };
    const FakeDoc = function () {} as unknown as { prototype: Record<string, unknown> };
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    new Function('window', 'history', 'location', 'Document', 'URL', 'Object', 'PopStateEvent',
      routerShim(bundleBlob, realBundlePath),
    )(window, history, location, FakeDoc, URL, Object, class {});
    return window.URL as (u: string) => URL;
  }

  it('maps the bundle blob back to the real bundle URL for HMR registration', () => {
    const blob = 'blob:http://localhost:5173/bundle-uuid-9';
    const path = '/index.bundle?platform=web&dev=true&hot=false&transform.engine=hermes';
    const ShimURL = evalRouterShim(blob, path);
    expect(new ShimURL(blob).toString()).toBe('http://localhost:5173' + path);
  });

  it('still virtualizes other blob: URLs to the clean route (not the bundle URL)', () => {
    const ShimURL = evalRouterShim('blob:http://localhost:5173/bundle-uuid-9', '/index.bundle?platform=web');
    // a different blob (the document) resolves to the virtual origin root, not /index.bundle
    expect(new ShimURL('blob:http://localhost:5173/other').pathname).toBe('/');
  });
});
