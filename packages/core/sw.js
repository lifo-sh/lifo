/**
 * Lifo service-worker transport — Phase 1 (HTTP).
 *
 * Routes requests into the in-page VM (portRegistry) via a MessageChannel to
 * the controlling playground tab, as a zero-setup alternative to the tunnel
 * relay.
 *
 * Routing principle: the /_sw/<port>/ prefix exists ONLY as the entry
 * navigation. Everything after that is routed by REQUESTER (client), not by
 * URL shape — so apps keep using absolute paths (/src/main.jsx) unmodified
 * and never see the prefix. Requests from unmapped clients (the playground
 * itself) pass through to the network untouched.
 */

// Preview routing. Each example/sandbox in the page is its own "box" (kernel +
// bridge); the boxId disambiguates them so several previews can be alive at
// once — and colliding port numbers across examples — all route to the right
// VM. Two forms:
//   FULL  /_sw/<boxId>/<port>/<path>  — box explicit (iframe entry URL)
//   PORT  /_sw/<port>/<path>          — box = the REQUESTING client's box
// The PORT form keeps sibling-service URLs working with no boxId baked in
// (e.g. an app's .env EXPO_PUBLIC_SUPABASE_URL=/_sw/54321 → the same box's
// backend). boxIds are `box_<alnum>` so they never collide with a numeric port.
const SW_PREFIX = /^\/_sw\/(box_[A-Za-z0-9]+)\/(\d+)(\/.*)?$/;
const SW_PREFIX_PORT = /^\/_sw\/(\d+)(\/.*)?$/;
const REQUEST_TIMEOUT_MS = 30000;

/** boxId → MessagePort to that box's host bridge (one per live example). */
const hostPorts = new Map();
/** requestId → { resolve, timer } (ids are globally unique across boxes). */
const pending = new Map();
/** clientId → { boxId, port } */
const clientBox = new Map();
/** connId → clientId, for routing WebSocket messages back to the app client */
const wsConnClient = new Map();
/**
 * An app page's visible URL (prefix stripped, no hash) → its box. A navigation or a worker
 * script has no requesting client, only a referrer, and that's the page's visible URL, which
 * a client's url (its creation URL, /_sw/<boxId>/<port>/…) never matches. Pages report it.
 */
const urlBox = new Map();
const withoutHash = (u) => String(u).split('#')[0];

/**
 * Injected into every VM-served HTML page, FIRST. The /_sw/<port>/ prefix is
 * only the routing entry — the app must believe it lives at the domain root,
 * exactly like on a real dev server. Client-side routers (Expo Router, React
 * Router) match routes against location.pathname; without this they see
 * /_sw/8081/ and render "Unmatched Route". Strip the prefix from the visible
 * URL before any app code runs; subsequent fetches stay correctly routed
 * because the SW maps this client's requests by clientId, not by path.
 */
const PATH_SHIM = `(function(){
  var m = location.pathname.match(/^\\/_sw\\/([A-Za-z0-9_-]+)\\/(\\d+)(\\/.*)?$/);
  if (!m) return;
  history.replaceState(history.state, '', (m[3] || '/') + location.search + location.hash);
  // Tell the service worker this page's visible URL (and every change of it), so a link it
  // follows or a worker it starts, which carry only that URL as referrer, route to its box.
  var report = function () {
    try {
      var sw = navigator.serviceWorker && navigator.serviceWorker.controller;
      if (sw) sw.postMessage({ type: 'lifo-client-url', url: location.href });
    } catch (e) {}
  };
  report();
  ['pushState', 'replaceState'].forEach(function (k) {
    var orig = history[k];
    history[k] = function () { var r = orig.apply(this, arguments); report(); return r; };
  });
  addEventListener('popstate', report);
  // Keep the page's own navigations and workers in its box. A host may let the service worker
  // control only /_sw/ (the playground keeps its own pages out of its hands), and a navigation
  // or a worker script is routed by its URL, not by the page that asked for it: a link to
  // /about.html, a form, location.href = '/x', a reload or new Worker('/worker.js') would land
  // on the host's server. Same-origin targets outside /_sw/ get this page's prefix back.
  var prefix = '/_sw/' + m[1] + '/' + m[2];
  var boxed = function (u) {
    try {
      var x = new URL(String(u), location.href);
      if (x.origin !== location.origin || x.protocol !== location.protocol || /^\\/_sw\\//.test(x.pathname)) return null;
      return prefix + x.pathname + x.search + x.hash;
    } catch (e) { return null; }
  };
  // Links, including ones opened in a new tab: the href carries the prefix while it's followed.
  var onLink = function (e) {
    if (e.defaultPrevented) return;
    var a = e.target && e.target.closest ? e.target.closest('a[href]') : null;
    if (!a || a.hasAttribute('download')) return;
    var href = a.getAttribute('href');
    var to = boxed(a.href);
    if (!to) return;
    a.setAttribute('href', to);
    setTimeout(function () { a.setAttribute('href', href); }, 0);
  };
  addEventListener('click', onLink);
  addEventListener('auxclick', onLink);
  // Forms: the action is read after the submit event, so it can still change here.
  addEventListener('submit', function (e) {
    if (e.defaultPrevented) return;
    var s = e.submitter;
    if (s && s.hasAttribute('formaction')) {
      var t1 = boxed(s.formAction);
      if (t1) s.setAttribute('formaction', t1);
    } else {
      var t2 = boxed(e.target.action);
      if (t2) e.target.setAttribute('action', t2);
    }
  });
  // Script navigations and reloads (location.href = '/x', location.reload()).
  var nav = window.navigation;
  if (nav && nav.addEventListener) {
    nav.addEventListener('navigate', function (e) {
      if (!e.cancelable || e.hashChange || e.formData || e.downloadRequest != null || e.destination.sameDocument) return;
      var to = boxed(e.destination.url);
      if (!to) return;
      e.preventDefault();
      if (e.navigationType === 'push') location.assign(to); else location.replace(to);
    });
  }
  ['Worker', 'SharedWorker'].forEach(function (name) {
    var Orig = window[name];
    if (typeof Orig !== 'function') return;
    var Boxed = function (url, options) { return new Orig(boxed(url) || url, options); };
    Boxed.prototype = Orig.prototype;
    window[name] = Boxed;
  });
  // Reload persistence: with the prefix stripped, reloading a top-level
  // preview tab would hit "/" and load the playground instead. Save the
  // restore target (with the CURRENT route at unload time, so client-side
  // navigation is preserved) in per-tab sessionStorage; the playground's
  // boot script redirects back when it finds the key. Top-level tabs only —
  // the iframe shares the parent tab's sessionStorage and must not hijack
  // the parent's reloads.
  if (window.top === window) {
    var prefix = '/_sw/' + m[1] + '/' + m[2];
    addEventListener('pagehide', function () {
      try {
        sessionStorage.setItem('lifo-preview-restore', JSON.stringify({ url: prefix + location.pathname + location.search + location.hash, t: Date.now() }));
      } catch (e) {}
    });
  }
})();`;

/**
 * Friendly page for "nothing is listening on this port" — shown for document
 * requests instead of the bridge's terse text 404. Polls the same URL and
 * reloads the moment a server binds the port, so `npm run dev` in the
 * terminal makes the preview appear without a manual refresh.
 */
function noServerPage(port, path) {
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Nothing on :${port}</title>
<style>
  body { margin:0; min-height:100vh; display:grid; place-items:center; background:#16161e; color:#c0caf5; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  .card { text-align:center; padding:2rem; max-width:34rem; }
  .code { font-size:3rem; font-weight:700; color:#414868; margin:0; }
  h1 { font-size:1rem; font-weight:600; margin:.75rem 0 .25rem; }
  p { font-size:.8rem; color:#565f89; line-height:1.6; margin:.25rem 0; }
  code { color:#7aa2f7; background:#1a1b26; padding:.1rem .4rem; border-radius:4px; }
  .dot { display:inline-block; width:.5em; height:.5em; border-radius:50%; background:#e0af68; margin-right:.4em; animation:pulse 1.2s ease-in-out infinite; }
  @keyframes pulse { 50% { opacity:.25 } }
</style>
</head>
<body>
<div class="card">
  <p class="code">404</p>
  <h1>Nothing is running on port ${port}</h1>
  <p>Start a dev server in the terminal — e.g. <code>npm run dev &</code> or <code>npm start</code>.</p>
  <p><span class="dot"></span>waiting for the port — this page reloads automatically</p>
</div>
<script>
  (function poll() {
    setTimeout(function () {
      fetch(location.href, { cache: 'no-store' }).then(function (r) {
        if (r.headers.get('x-lifo') !== 'no-server') location.reload();
        else poll();
      }).catch(poll);
    }, 1500);
  })();
</script>
</body>
</html>`;
}

/**
 * Injected into every VM-served HTML page. Replaces same-origin WebSocket with
 * a shim that tunnels through the service worker → host page → in-VM ws server
 * (Vite HMR). WebSockets can't be intercepted by a SW's fetch handler, so the
 * app's own WebSocket constructor is what we must stand in for. Runs as a
 * classic inline script so it executes before Vite's deferred module scripts.
 */
const WS_SHIM = `(function(){
  var sw = navigator.serviceWorker;
  if (!sw || !sw.controller) return;
  var OrigWS = window.WebSocket;
  var conns = new Map();
  var seq = 0;
  function b64enc(u8){var s='';for(var i=0;i<u8.length;i++)s+=String.fromCharCode(u8[i]);return btoa(s);}
  function b64dec(b){var s=atob(b),u=new Uint8Array(s.length);for(var i=0;i<s.length;i++)u[i]=s.charCodeAt(i);return u;}
  sw.addEventListener('message', function(e){
    var m = e.data||{}; if(!m.connId) return;
    var c = conns.get(m.connId); if(!c) return;
    if(m.type==='ws-opened') c.__open();
    else if(m.type==='ws-message') c.__msg(m.data, m.binary);
    else if(m.type==='ws-close'){ conns.delete(m.connId); c.__close(1006,''); }
  });
  function LifoWebSocket(url, protocols){
    var u; try{ u = new URL(url, location.href); }catch(_){ return new OrigWS(url, protocols); }
    // WebSocket URLs use ws:/wss: schemes, so URL.origin never equals the
    // page's http(s) origin — compare host + scheme instead. Only same-host
    // ws(s) connections tunnel through the SW; anything else stays native.
    var sameHost = u.host === location.host && (u.protocol === 'ws:' || u.protocol === 'wss:');
    if(!sameHost) return new OrigWS(url, protocols);
    var self = this;
    this.url = u.href;
    this.readyState = 0;
    this.bufferedAmount = 0;
    this.extensions = '';
    this.protocol = Array.isArray(protocols)?(protocols[0]||''):(protocols||'');
    this.binaryType = 'blob';
    this.onopen=null; this.onmessage=null; this.onclose=null; this.onerror=null;
    this._listeners = {open:[],message:[],close:[],error:[]};
    this.connId = 'ws'+(seq++)+'-'+Math.random().toString(36).slice(2);
    conns.set(this.connId, this);
    navigator.serviceWorker.controller.postMessage({type:'ws-open',connId:this.connId,url:u.pathname+u.search,protocol:this.protocol});
    this.__open=function(){ self.readyState=1; self.__emit('open',{}); };
    this.__msg=function(b64,binary){
      var data;
      if(binary){ var buf=b64dec(b64).buffer; data = self.binaryType==='arraybuffer'?buf:new Blob([buf]); }
      else { data = new TextDecoder().decode(b64dec(b64)); }
      self.__emit('message',{data:data});
    };
    this.__close=function(code,reason){ if(self.readyState===3)return; self.readyState=3; self.__emit('close',{code:code||1000,reason:reason||'',wasClean:code===1000}); };
    this.__emit=function(type,init){
      var ev;
      try{ ev = type==='message'?new MessageEvent('message',init):new (type==='close'?CloseEvent:Event)(type,init); }
      catch(_){ ev={type:type}; for(var k in init) ev[k]=init[k]; }
      var h=self['on'+type]; if(h) try{h.call(self,ev);}catch(_){}
      self._listeners[type].forEach(function(fn){ try{fn.call(self,ev);}catch(_){} });
    };
  }
  LifoWebSocket.prototype.send=function(data){
    var u8;
    if(typeof data==='string') u8=new TextEncoder().encode(data);
    else if(data instanceof ArrayBuffer) u8=new Uint8Array(data);
    else if(ArrayBuffer.isView(data)) u8=new Uint8Array(data.buffer,data.byteOffset,data.byteLength);
    else u8=new TextEncoder().encode(String(data));
    navigator.serviceWorker.controller.postMessage({type:'ws-send',connId:this.connId,data:b64enc(u8),binary:typeof data!=='string'});
  };
  LifoWebSocket.prototype.close=function(code,reason){
    if(this.readyState>=2)return; this.readyState=2;
    navigator.serviceWorker.controller.postMessage({type:'ws-close',connId:this.connId});
    this.__close(code||1000,reason||'');
  };
  LifoWebSocket.prototype.addEventListener=function(t,fn){ if(this._listeners[t]) this._listeners[t].push(fn); };
  LifoWebSocket.prototype.removeEventListener=function(t,fn){ if(this._listeners[t]){var i=this._listeners[t].indexOf(fn); if(i>=0)this._listeners[t].splice(i,1);} };
  LifoWebSocket.prototype.dispatchEvent=function(){ return true; };
  LifoWebSocket.CONNECTING=0; LifoWebSocket.OPEN=1; LifoWebSocket.CLOSING=2; LifoWebSocket.CLOSED=3;
  window.WebSocket = LifoWebSocket;
})();`;

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

async function routeToClient(connId, msg) {
	const clientId = wsConnClient.get(connId);
	if (!clientId) return;
	const client = await self.clients.get(clientId);
	if (client) client.postMessage(msg);
	if (msg.type === 'ws-close') wsConnClient.delete(connId);
}

self.addEventListener('message', (event) => {
	const data = event.data || {};

	if (data.type === 'lifo-client-url' && event.source && typeof data.url === 'string') {
		let box = clientBox.get(event.source.id);
		if (!box) {
			const cm = new URL(event.source.url).pathname.match(SW_PREFIX);
			if (cm) box = { boxId: cm[1], port: parseInt(cm[2], 10) };
		}
		if (box) {
			urlBox.delete(withoutHash(data.url)); // re-insert: the newest page wins, oldest go first
			urlBox.set(withoutHash(data.url), box);
			if (urlBox.size > 500) urlBox.delete(urlBox.keys().next().value);
		}
		return;
	}

	if (data.type === 'lifo-connect' && event.ports && event.ports[0] && data.boxId) {
		const boxId = data.boxId;
		const prev = hostPorts.get(boxId);
		if (prev) { try { prev.close(); } catch { /* already closed */ } }
		const port = event.ports[0];
		hostPorts.set(boxId, port);
		port.onmessage = (ev) => {
			const msg = ev.data || {};
			if (msg.type === 'response') {
				const entry = pending.get(msg.requestId);
				if (entry) {
					pending.delete(msg.requestId);
					clearTimeout(entry.timer);
					entry.resolve(msg);
				}
			} else if (msg.type === 'ws-opened' || msg.type === 'ws-message' || msg.type === 'ws-close') {
				void routeToClient(msg.connId, msg);
			}
		};
		port.postMessage({ type: 'lifo-connected' });
		return;
	}

	// WebSocket messages from an app client's shim → forward to the client's box.
	if (data.type === 'ws-open' && event.source) {
		const client = event.source;
		void (async () => {
			// The client's own box (from its controlling URL).
			let clientOwn = clientBox.get(client.id);
			if (!clientOwn) {
				const cm = new URL(client.url).pathname.match(SW_PREFIX);
				if (cm) { clientOwn = { boxId: cm[1], port: parseInt(cm[2], 10) }; clientBox.set(client.id, clientOwn); }
			}
			// Resolve the socket's target: FULL /_sw/<boxId>/<port>/ is explicit;
			// PORT /_sw/<port>/ is a sibling service in the client's own box;
			// otherwise it's the client's own app port.
			const full = data.url.match(SW_PREFIX);
			const portOnly = !full && data.url.match(SW_PREFIX_PORT);
			let target;
			let clean;
			if (full) {
				target = { boxId: full[1], port: parseInt(full[2], 10) };
				clean = full[3] || '/';
			} else if (portOnly && clientOwn) {
				target = { boxId: clientOwn.boxId, port: parseInt(portOnly[1], 10) };
				clean = portOnly[2] || '/';
			} else {
				target = clientOwn;
				clean = data.url;
			}
			if (!target || !(await ensureHost(target.boxId))) {
				client.postMessage({ type: 'ws-close', connId: data.connId });
				return;
			}
			wsConnClient.set(data.connId, client.id);
			hostPorts.get(target.boxId).postMessage({ type: 'ws-open', connId: data.connId, port: target.port, url: clean, protocol: data.protocol });
		})();
		return;
	}
	if ((data.type === 'ws-send' || data.type === 'ws-close') && data.connId) {
		// Route to the box that owns this connection's client.
		const clientId = wsConnClient.get(data.connId);
		const box = clientId ? clientBox.get(clientId) : null;
		const p = box ? hostPorts.get(box.boxId) : null;
		if (p) p.postMessage(data);
		if (data.type === 'ws-close') wsConnClient.delete(data.connId);
		return;
	}
});

function bufToB64(buf) {
	const bytes = new Uint8Array(buf);
	let bin = '';
	for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
	return btoa(bin);
}

function b64ToBuf(b64) {
	const bin = atob(b64);
	const bytes = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
	return bytes;
}

/**
 * Ensure a host page is connected. The SW may have just been revived from
 * idle-termination with no hostPort — ask window clients (the playground tab)
 * to re-announce, and wait briefly for the reconnect.
 */
async function ensureHost(boxId, timeoutMs = 5000) {
	if (hostPorts.has(boxId)) return true;
	const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
	for (const c of clients) c.postMessage({ type: 'lifo-need-host' });
	const deadline = Date.now() + timeoutMs;
	while (!hostPorts.has(boxId) && Date.now() < deadline) {
		await new Promise((r) => setTimeout(r, 40));
	}
	return hostPorts.has(boxId);
}

function vmRequest(boxId, port, path, request, bodyB64) {
	return new Promise((resolve) => {
		const host = hostPorts.get(boxId);
		if (!host) { resolve(null); return; }
		const requestId = Math.random().toString(36).slice(2) + Date.now().toString(36);
		const timer = setTimeout(() => {
			pending.delete(requestId);
			resolve(null);
		}, REQUEST_TIMEOUT_MS);
		pending.set(requestId, { resolve, timer });
		const headers = {};
		for (const [k, v] of request.headers.entries()) headers[k] = v;
		// The app believes it's served at http://localhost:<port>, so present the request as a
		// browser would send it there. A service worker never sees the Origin, Referer and
		// Sec-Fetch-* headers the browser adds on the way to the network, and same-origin checks
		// need them (TanStack Start answers a server function call without them with 403).
		// Every request reaching the box comes from one of its own pages: same-origin.
		const appOrigin = 'http://localhost:' + port;
		if (!headers.host) headers.host = 'localhost:' + port;
		if (!headers['sec-fetch-site']) headers['sec-fetch-site'] = 'same-origin';
		if (!headers['sec-fetch-mode']) headers['sec-fetch-mode'] = request.mode || 'cors';
		if (!headers['sec-fetch-dest']) headers['sec-fetch-dest'] = request.destination || 'empty';
		if (headers.origin === self.location.origin || (!headers.origin && request.method !== 'GET' && request.method !== 'HEAD')) {
			headers.origin = appOrigin;
		}
		const referrer = headers.referer || request.referrer;
		if (referrer && referrer !== 'about:client') {
			try {
				const ref = new URL(referrer);
				if (ref.origin === self.location.origin) {
					const m = ref.pathname.match(SW_PREFIX);
					headers.referer = appOrigin + (m ? (m[3] || '/') : ref.pathname) + ref.search;
				}
			} catch { /* not a URL: leave it out */ }
		}
		// The browser omits Content-Length from request.headers (a forbidden
		// header it manages itself), but in-VM body parsers need it — e.g.
		// body-parser/express.json only parses when hasBody() sees content-length
		// or transfer-encoding. Restore it from the actual body byte length.
		if (bodyB64 && headers['content-length'] == null && headers['transfer-encoding'] == null) {
			headers['content-length'] = String(b64ToBuf(bodyB64).length);
		}
		host.postMessage({
			type: 'request',
			requestId,
			port,
			method: request.method,
			url: path,
			headers,
			body: bodyB64,
		});
	});
}

// Hop-by-hop / response-forbidden headers we must not replay
const STRIP_HEADERS = new Set(['set-cookie', 'content-encoding', 'content-length', 'transfer-encoding', 'connection', 'keep-alive']);

async function serveFromVm(event, boxId, port, path) {
	let bodyB64 = '';
	if (event.request.method !== 'GET' && event.request.method !== 'HEAD') {
		bodyB64 = bufToB64(await event.request.arrayBuffer());
	}
	if (!hostPorts.has(boxId)) await ensureHost(boxId);
	const res = await vmRequest(boxId, port, path, event.request, bodyB64);
	if (!res) {
		return new Response(
			'Lifo VM is not connected. Keep the playground tab open (it hosts the virtual machine), then reload.',
			{ status: 503, headers: { 'content-type': 'text/plain' } },
		);
	}
	const headers = {};
	let contentType = '';
	let lifoMarker = '';
	for (const [k, v] of Object.entries(res.headers || {})) {
		if (STRIP_HEADERS.has(k.toLowerCase())) continue;
		headers[k] = v;
		if (k.toLowerCase() === 'content-type') contentType = String(v).toLowerCase();
		if (k.toLowerCase() === 'x-lifo') lifoMarker = String(v);
	}

	// Port not bound: render the friendly auto-reloading 404 for documents
	// (iframes / tabs); non-document requests keep the terse text response.
	const wantsHtml = event.request.destination === 'document'
		|| (event.request.headers.get('accept') || '').includes('text/html');
	if (res.statusCode === 404 && lifoMarker === 'no-server' && wantsHtml) {
		return new Response(noServerPage(port, path), {
			status: 404,
			headers: { 'content-type': 'text/html; charset=utf-8', 'x-lifo': 'no-server' },
		});
	}

	// The body arrives as a transferred ArrayBuffer (bodyBuffer) — zero-copy,
	// binary-safe. Older bridges may still send base64 `body`.
	let bodyBuf = res.bodyBuffer instanceof ArrayBuffer
		? new Uint8Array(res.bodyBuffer)
		: (res.body ? b64ToBuf(res.body) : null);

	// Inject the WebSocket shim into HTML documents so the app's HMR socket
	// (and any same-origin WebSocket) tunnels through the SW. The app on disk
	// is never touched — this is a proxy-level seam, like the relay's byte pipe.
	if (contentType.includes('text/html') && bodyBuf) {
		let html = new TextDecoder().decode(bodyBuf);
		// Each script removes itself once it has run, so the document is exactly what the server
		// rendered: React hydrates whole documents (TanStack Start), and an extra <script> in
		// <head> was a hydration mismatch.
		const selfRemove = ';(function(){var s=document.currentScript;if(s&&s.parentNode)s.parentNode.removeChild(s);})();';
		const tag = `<script>${PATH_SHIM}${selfRemove}</script><script>${WS_SHIM}${selfRemove}</script>`;
		// First thing in <head>, which may carry attributes (<head data-tsd-source=…>); else
		// right after <html …> or the doctype. Never before the doctype: that put the page in
		// quirks mode, and the parser then dropped the real <head>'s attributes.
		const at = /<head(?:\s[^>]*)?>/i.exec(html) || /<html(?:\s[^>]*)?>/i.exec(html) || /<!doctype[^>]*>/i.exec(html);
		html = at
			? html.slice(0, at.index + at[0].length) + tag + html.slice(at.index + at[0].length)
			: tag + html;
		delete headers['Content-Length'];
		delete headers['content-length'];
		return new Response(html, { status: res.statusCode || 200, headers });
	}

	// 204/205/304 are null-body statuses — the Response constructor throws if
	// given a body (even an empty buffer), which rejected e.g. DELETE → 204.
	const nullBody = res.statusCode === 204 || res.statusCode === 205 || res.statusCode === 304;
	return new Response(nullBody ? null : bodyBuf, { status: res.statusCode || 200, headers });
}

async function boxForRequest(event) {
	// Subresources: the requesting client determines the box.
	if (event.clientId) {
		if (clientBox.has(event.clientId)) return clientBox.get(event.clientId);
		// SW may have restarted and lost the map — re-derive from the client URL.
		const client = await self.clients.get(event.clientId);
		if (client) {
			const m = new URL(client.url).pathname.match(SW_PREFIX);
			if (m) {
				const box = { boxId: m[1], port: parseInt(m[2], 10) };
				clientBox.set(event.clientId, box);
				return box;
			}
		}
		return null;
	}
	// Navigations and worker scripts carry no clientId — resolve via the referrer.
	const dest = event.request.destination;
	const noClient = event.request.mode === 'navigate' || dest === 'worker' || dest === 'sharedworker';
	if (noClient && event.request.referrer) {
		let ref;
		try { ref = new URL(event.request.referrer); } catch { return null; }
		if (ref.origin !== self.location.origin) return null;
		const m = ref.pathname.match(SW_PREFIX);
		if (m) return { boxId: m[1], port: parseInt(m[2], 10) };
		const reported = urlBox.get(withoutHash(event.request.referrer));
		if (reported) return reported;
		const all = await self.clients.matchAll({ type: 'window' });
		const refClient = all.find((c) => c.url === event.request.referrer);
		if (refClient && clientBox.has(refClient.id)) return clientBox.get(refClient.id);
	}
	return null;
}

self.addEventListener('fetch', (event) => {
	const url = new URL(event.request.url);
	if (url.origin !== self.location.origin) return;

	// Entry point: /_sw/<boxId>/<port>/... → strip prefix, map the document.
	const m = url.pathname.match(SW_PREFIX);
	if (m) {
		const boxId = m[1];
		const port = parseInt(m[2], 10);
		const path = (m[3] || '/') + url.search;
		if (event.resultingClientId) clientBox.set(event.resultingClientId, { boxId, port });
		event.respondWith(serveFromVm(event, boxId, port, path));
		return;
	}

	// Sibling-service: /_sw/<port>/... with no boxId → the REQUESTING client's
	// box, that port (e.g. an app fetching its own backend on 54321).
	const mp = url.pathname.match(SW_PREFIX_PORT);
	if (mp) {
		event.respondWith((async () => {
			const box = await boxForRequest(event);
			if (!box) return fetch(event.request);
			return serveFromVm(event, box.boxId, parseInt(mp[1], 10), (mp[2] || '/') + url.search);
		})());
		return;
	}

	// Client-based routing: app clients get their box's VM, everyone else the network.
	event.respondWith((async () => {
		const box = await boxForRequest(event);
		if (!box) return fetch(event.request);
		// A page in the box that opens a document or starts a worker: that new client is in the
		// box too, so its own requests (a worker's fetch('/data.json')) route the same way.
		const dest = event.request.destination;
		if (event.resultingClientId && (event.request.mode === 'navigate' || dest === 'worker' || dest === 'sharedworker')) {
			clientBox.set(event.resultingClientId, box);
		}
		return serveFromVm(event, box.boxId, box.port, url.pathname + url.search);
	})());
});
