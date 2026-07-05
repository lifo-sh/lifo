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

const SW_PREFIX = /^\/_sw\/(\d+)(\/.*)?$/;
const REQUEST_TIMEOUT_MS = 30000;

/** MessagePort to the VM host page (last connected tab wins, like the relay). */
let hostPort = null;
/** requestId → { resolve, timer } */
const pending = new Map();
/** clientId → virtual port */
const clientPorts = new Map();
/** connId → clientId, for routing WebSocket messages back to the app client */
const wsConnClient = new Map();

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

	if (data.type === 'lifo-connect' && event.ports && event.ports[0]) {
		if (hostPort) {
			try { hostPort.close(); } catch { /* already closed */ }
		}
		hostPort = event.ports[0];
		hostPort.onmessage = (ev) => {
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
		hostPort.postMessage({ type: 'lifo-connected' });
		return;
	}

	// WebSocket messages from an app client's shim → forward to the host bridge,
	// tagged with the client's virtual port.
	if (data.type === 'ws-open' && event.source) {
		const client = event.source;
		void (async () => {
			// An explicit /_sw/<port>/ in the ws URL targets that port (e.g. a
			// realtime socket to a sibling backend). Otherwise the socket belongs
			// to the client's own app port.
			const prefixMatch = data.url.match(SW_PREFIX);
			let port = prefixMatch ? parseInt(prefixMatch[1], 10) : clientPorts.get(client.id);
			if (port == null) {
				// SW may have restarted — re-derive the client's port from its URL.
				const m = new URL(client.url).pathname.match(SW_PREFIX);
				if (m) { port = parseInt(m[1], 10); clientPorts.set(client.id, port); }
			}
			if (port == null || !(await ensureHost())) {
				client.postMessage({ type: 'ws-close', connId: data.connId });
				return;
			}
			wsConnClient.set(data.connId, client.id);
			const clean = data.url.replace(SW_PREFIX, (_m, _p, rest) => rest || '/');
			hostPort.postMessage({ type: 'ws-open', connId: data.connId, port, url: clean, protocol: data.protocol });
		})();
		return;
	}
	if ((data.type === 'ws-send' || data.type === 'ws-close') && data.connId) {
		if (hostPort) hostPort.postMessage(data);
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
async function ensureHost(timeoutMs = 5000) {
	if (hostPort) return true;
	const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
	for (const c of clients) c.postMessage({ type: 'lifo-need-host' });
	const deadline = Date.now() + timeoutMs;
	while (!hostPort && Date.now() < deadline) {
		await new Promise((r) => setTimeout(r, 40));
	}
	return !!hostPort;
}

function vmRequest(port, path, request, bodyB64) {
	return new Promise((resolve) => {
		if (!hostPort) { resolve(null); return; }
		const requestId = Math.random().toString(36).slice(2) + Date.now().toString(36);
		const timer = setTimeout(() => {
			pending.delete(requestId);
			resolve(null);
		}, REQUEST_TIMEOUT_MS);
		pending.set(requestId, { resolve, timer });
		const headers = {};
		for (const [k, v] of request.headers.entries()) headers[k] = v;
		hostPort.postMessage({
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

async function serveFromVm(event, port, path) {
	let bodyB64 = '';
	if (event.request.method !== 'GET' && event.request.method !== 'HEAD') {
		bodyB64 = bufToB64(await event.request.arrayBuffer());
	}
	if (!hostPort) await ensureHost();
	const res = await vmRequest(port, path, event.request, bodyB64);
	if (!res) {
		return new Response(
			'Lifo VM is not connected. Keep the playground tab open (it hosts the virtual machine), then reload.',
			{ status: 503, headers: { 'content-type': 'text/plain' } },
		);
	}
	const headers = {};
	let contentType = '';
	for (const [k, v] of Object.entries(res.headers || {})) {
		if (STRIP_HEADERS.has(k.toLowerCase())) continue;
		headers[k] = v;
		if (k.toLowerCase() === 'content-type') contentType = String(v).toLowerCase();
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
		const tag = `<script>${WS_SHIM}</script>`;
		const headIdx = html.indexOf('<head>');
		html = headIdx !== -1
			? html.slice(0, headIdx + 6) + tag + html.slice(headIdx + 6)
			: tag + html;
		delete headers['Content-Length'];
		delete headers['content-length'];
		return new Response(html, { status: res.statusCode || 200, headers });
	}

	return new Response(bodyBuf, { status: res.statusCode || 200, headers });
}

async function portForRequest(event) {
	// Subresources: the requesting client determines the app.
	if (event.clientId) {
		if (clientPorts.has(event.clientId)) return clientPorts.get(event.clientId);
		// SW may have restarted and lost the map — re-derive from the client URL.
		const client = await self.clients.get(event.clientId);
		if (client) {
			const m = new URL(client.url).pathname.match(SW_PREFIX);
			if (m) {
				const port = parseInt(m[1], 10);
				clientPorts.set(event.clientId, port);
				return port;
			}
		}
		return null;
	}
	// Navigations carry no clientId — resolve via the referrer.
	if (event.request.mode === 'navigate' && event.request.referrer) {
		let ref;
		try { ref = new URL(event.request.referrer); } catch { return null; }
		if (ref.origin !== self.location.origin) return null;
		const m = ref.pathname.match(SW_PREFIX);
		if (m) return parseInt(m[1], 10);
		const all = await self.clients.matchAll({ type: 'window' });
		const refClient = all.find((c) => c.url === event.request.referrer);
		if (refClient && clientPorts.has(refClient.id)) return clientPorts.get(refClient.id);
	}
	return null;
}

self.addEventListener('fetch', (event) => {
	const url = new URL(event.request.url);
	if (url.origin !== self.location.origin) return;

	// Entry point: /_sw/<port>/... → strip prefix, map the resulting document.
	const m = url.pathname.match(SW_PREFIX);
	if (m) {
		const port = parseInt(m[1], 10);
		const path = (m[2] || '/') + url.search;
		if (event.resultingClientId) clientPorts.set(event.resultingClientId, port);
		event.respondWith(serveFromVm(event, port, path));
		return;
	}

	// Client-based routing: app clients get the VM, everyone else the network.
	event.respondWith((async () => {
		const port = await portForRequest(event);
		if (port == null) return fetch(event.request);
		if (event.request.mode === 'navigate' && event.resultingClientId) {
			clientPorts.set(event.resultingClientId, port);
		}
		return serveFromVm(event, port, url.pathname + url.search);
	})());
});
