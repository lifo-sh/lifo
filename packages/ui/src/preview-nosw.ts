/**
 * preview-nosw.ts — service-worker-FREE preview transport for @lifo-sh/ui.
 *
 * Instead of proxying the iframe's requests through a service worker, we:
 *   1. Fetch the app's HTML + JS bundle from the in-VM dev server directly via
 *      kernel.portRegistry (host-side, no SW).
 *   2. Rewrite the bundle's static asset URLs to blob: URLs.
 *   3. Serve the bundle + HTML to the iframe as blob: URLs, with injected shims
 *      (fetch/XHR/WebSocket) that tunnel the app's RUNTIME requests to the parent
 *      via window.postMessage.
 *   4. The parent answers those over the SAME message protocol the SW used, by
 *      reusing ServiceWorkerBridge.attach() with a postMessage adapter port.
 *
 * This makes the preview work where service workers are unreliable (iOS Chrome,
 * cross-origin iframes). HMR rides the WebSocket shim.
 */
import { ServiceWorkerBridge, dispatchRequest } from '@lifo-sh/core';
import type { Kernel } from '@lifo-sh/core';
import { buildPreviewShim } from './preview-shims.js';

interface VmResponse { status: number; headers: Record<string, string>; body: Uint8Array }

/**
 * Call a bound in-VM port directly (no SW) and await its full response.
 *
 * This used to hand-roll the `_donePromise` await — one of five copies of that
 * dance. `dispatchRequest` owns it now, along with the timeout and the
 * bodyBytes fallback.
 */
async function vmFetch(kernel: Kernel, port: number, url: string, timeoutMs = 120000): Promise<VmResponse> {
  const res = await dispatchRequest(
    kernel.portRegistry,
    port,
    { method: 'GET', url, headers: { host: `localhost:${port}` } },
    { timeoutMs },
  );
  return { status: res.statusCode, headers: res.headers, body: res.bodyBytes };
}

/**
 * The transport shim injected into the preview document, before the bundle.
 *
 * Composed from the individually selectable patches in preview-shims.ts —
 * import `buildPreviewShim` directly to take a subset (e.g. HTTP only) in
 * another embedder.
 */
export function shimScript(port: number, hostOrigin = ''): string {
  return buildPreviewShim({ port, hostOrigin });
}

/**
 * Router shim. blob: documents can't change location.pathname, so client
 * routers see the blob UUID and render "Unmatched Route". This virtualizes
 * document.URL, the URL constructor, and the History stack, carrying the real
 * route in location.hash so the router reads a clean "/" path.
 */
function routerShim(bundleBlob: string, realBundlePath: string): string {
  return `(function() {
  var BUNDLE_BLOB = ${JSON.stringify(bundleBlob)};
  var BUNDLE_PATH = ${JSON.stringify(realBundlePath)};
  var rawHash = location.hash.slice(1) || '/';
  var hashIdx = rawHash.indexOf('#');
  var virtualHash = '';
  var pathAndSearch = rawHash;
  if (hashIdx > 0) { virtualHash = rawHash.slice(hashIdx); pathAndSearch = rawHash.slice(0, hashIdx); }
  var searchIdx = pathAndSearch.indexOf('?');
  var virtualPathname = searchIdx >= 0 ? pathAndSearch.slice(0, searchIdx) : pathAndSearch;
  var virtualSearch = searchIdx >= 0 ? pathAndSearch.slice(searchIdx) : '';
  if (virtualPathname.charAt(0) !== '/') virtualPathname = '/' + virtualPathname;
  var virtualOrigin = location.origin || 'http://localhost';
  var virtualHref = virtualOrigin + virtualPathname + virtualSearch + virtualHash;
  try { Object.defineProperty(Document.prototype, 'URL', { get: function() { return virtualHref; }, configurable: true }); } catch(e) {}
  var OrigURL = URL;
  var _URL = function(url, base) { var u = String(url);
    if (BUNDLE_BLOB && u === BUNDLE_BLOB) return new OrigURL(virtualOrigin + BUNDLE_PATH);
    if (u.indexOf('blob:') === 0) u = virtualHref; if (arguments.length > 1) return new OrigURL(u, base); return new OrigURL(u); };
  _URL.prototype = OrigURL.prototype;
  _URL.createObjectURL = OrigURL.createObjectURL; _URL.revokeObjectURL = OrigURL.revokeObjectURL; _URL.canParse = OrigURL.canParse;
  window.URL = _URL;
  var _realReplaceState = history.replaceState;
  var _blobBase = location.href.split('#')[0];
  var stack = [{ state: null, pathname: virtualPathname, search: virtualSearch, hash: virtualHash }];
  var stackIndex = 0;
  function currentEntry() { return stack[stackIndex]; }
  function sync() {
    var e = currentEntry();
    virtualPathname = e.pathname; virtualSearch = e.search; virtualHash = e.hash;
    virtualHref = virtualOrigin + virtualPathname + virtualSearch + virtualHash;
    var routeHash = '#' + e.pathname + e.search;
    window.__ROUTER_SHIM_HASH__ = routeHash;
    var newUrl = _blobBase + routeHash;
    if (newUrl !== location.href) { try { _realReplaceState.call(history, e.state, '', newUrl); } catch(e) {} }
  }
  function parseUrl(url) {
    var s = String(url);
    if (s.indexOf('blob:') === 0) { try { var inner = new OrigURL(s.slice(5)); s = inner.pathname + inner.search + inner.hash; } catch(e) {} }
    try { var u = new OrigURL(s, virtualOrigin); return { pathname: u.pathname, search: u.search, hash: u.hash }; } catch(e) {}
    var pathname = s, search = '', hash = '';
    var hi = pathname.indexOf('#'); if (hi >= 0) { hash = pathname.slice(hi); pathname = pathname.slice(0, hi); }
    var si = pathname.indexOf('?'); if (si >= 0) { search = pathname.slice(si); pathname = pathname.slice(0, si); }
    if (!pathname) pathname = '/'; if (pathname.charAt(0) !== '/') pathname = '/' + pathname;
    return { pathname: pathname, search: search, hash: hash };
  }
  history.pushState = function(state, title, url) { if (url != null) { var p = parseUrl(url); stack = stack.slice(0, stackIndex + 1); stack.push({ state: state, pathname: p.pathname, search: p.search, hash: '' }); stackIndex = stack.length - 1; sync(); } };
  history.replaceState = function(state, title, url) { if (url != null) { var p = parseUrl(url); stack[stackIndex] = { state: state, pathname: p.pathname, search: p.search, hash: '' }; sync(); } };
  history.go = function(n) { if (!n) return; var ni = stackIndex + n; if (ni < 0) ni = 0; if (ni >= stack.length) ni = stack.length - 1; if (ni === stackIndex) return; stackIndex = ni; sync(); window.dispatchEvent(new PopStateEvent('popstate', { state: currentEntry().state })); };
  history.back = function() { history.go(-1); }; history.forward = function() { history.go(1); };
  Object.defineProperty(history, 'state', { get: function() { return currentEntry().state; }, configurable: true });
  sync();
})();`;
}

export interface NoSwPreviewHandle {
  iframe: HTMLIFrameElement;
  destroy(): void;
}

/**
 * Mount a service-worker-free preview of an in-VM dev server into `iframe`.
 * Returns a handle whose destroy() revokes blob URLs and detaches the bridge.
 */
export async function mountNoSwPreview(
  iframe: HTMLIFrameElement,
  kernel: Kernel,
  port: number,
  path = '/',
): Promise<NoSwPreviewHandle> {
  const blobUrls: string[] = [];
  const mkBlob = (bytes: Uint8Array, type: string) => { const u = URL.createObjectURL(new Blob([bytes as BlobPart], { type })); blobUrls.push(u); return u; };

  // Fetch the ENTRY DOCUMENT at `path`, not always at '/'. A server's root is
  // not necessarily its app: tinbase answers '/' with a JSON health check and
  // serves the studio at '/_/', so mounting with path='/_/' used to blob the
  // health JSON and render nothing.
  const entryPath = path || '/';
  const deadline = Date.now() + 180000;
  let htmlRes = await vmFetch(kernel, port, entryPath);
  while ((htmlRes.status !== 200 || htmlRes.headers['x-lifo'] === 'no-server') && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 800));
    htmlRes = await vmFetch(kernel, port, entryPath);
  }

  let html = new TextDecoder().decode(htmlRes.body);

  // Find the bundle <script src>, fetch it, rewrite to blob.
  let bundleBlob = '';
  let realBundlePath = '';
  const scriptMatch = html.match(/<script\s+src=["']([^"']+\.bundle[^"']*)["']/i);
  if (scriptMatch) {
    realBundlePath = scriptMatch[1].startsWith('/') ? scriptMatch[1] : '/' + scriptMatch[1];
    const bundleRes = await vmFetch(kernel, port, realBundlePath);
    let bundleBytes = bundleRes.body;
    if (bundleRes.status !== 200) {
      // A failed build (Metro answers the bundle request with a 500 + JSON
      // error) must not be executed as JavaScript — render the error instead
      // of a silently broken iframe.
      let msg = new TextDecoder().decode(bundleRes.body);
      try {
        const j = JSON.parse(msg) as { message?: string };
        if (j?.message) msg = j.message;
      } catch { /* not JSON — show raw body */ }
      const overlay = `(function(){var o=document.createElement('pre');o.style.cssText='position:fixed;inset:0;z-index:2147483647;margin:0;padding:24px;box-sizing:border-box;background:rgba(22,22,30,.97);color:#f7768e;font:12.5px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace;white-space:pre-wrap;overflow:auto';o.textContent=${JSON.stringify('Build failed (HTTP ' + bundleRes.status + ')\n\n' + msg)};(document.body||document.documentElement).appendChild(o);})();`;
      bundleBytes = new TextEncoder().encode(overlay);
    }
    bundleBlob = mkBlob(bundleBytes, 'application/javascript');
    html = html.replace(scriptMatch[0], `<script src="${bundleBlob}"`);
  }

  // Inject router shim + transport shim before the bundle.
  // Captured HERE, in the parent document: inside the blob preview
  // `location.host` is the empty string, so the embedder's origin has to be
  // baked in (see resolveVmTarget).
  const hostOrigin = typeof location !== 'undefined' ? location.origin : '';
  html = html.replace(/<head(\s[^>]*)?>/i, (h) => `${h}\n<script>${routerShim(bundleBlob, realBundlePath)}</script>\n<script>${shimScript(port, hostOrigin)}</script>`);

  // Serve the HTML as a blob.
  const hashPath = path && path !== '/' ? '#' + path.replace(/^\//, '') : '';
  const htmlBlob = mkBlob(new TextEncoder().encode(html), 'text/html');

  // Reuse ServiceWorkerBridge with a postMessage adapter "port".
  const bridge = new ServiceWorkerBridge(kernel.portRegistry);
  const adapter = {
    postMessage: (msg: unknown, transfer?: Transferable[]) => iframe.contentWindow?.postMessage(msg, '*', transfer ?? []),
    onmessage: null as ((e: MessageEvent) => void) | null,
    start() {}, close() {},
  };
  const onWindowMessage = (e: MessageEvent) => { if (e.source === iframe.contentWindow) adapter.onmessage?.(e); };
  window.addEventListener('message', onWindowMessage);
  bridge.attach(adapter as unknown as MessagePort);

  iframe.src = htmlBlob + hashPath;

  return {
    iframe,
    destroy() {
      window.removeEventListener('message', onWindowMessage);
      try { bridge.destroy(); } catch { /* ignore */ }
      for (const u of blobUrls) URL.revokeObjectURL(u);
    },
  };
}
