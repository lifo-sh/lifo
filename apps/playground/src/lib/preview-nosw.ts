/**
 * preview-nosw.ts — service-worker-FREE preview transport.
 *
 * Instead of proxying the iframe's requests through a service worker, we:
 *   1. Fetch the app's HTML + JS bundle from the in-VM dev server directly via
 *      kernel.portRegistry (host-side, no SW).
 *   2. Rewrite the bundle's static asset URLs (/assets/…) to blob: URLs the host
 *      pre-fetches (blobs, not data URIs — short + fast).
 *   3. Serve the bundle + HTML to the iframe as blob: URLs, with injected shims
 *      (fetch/XHR/WebSocket) that tunnel the app's RUNTIME requests to the parent
 *      via window.postMessage.
 *   4. The parent answers those over the SAME message protocol the SW used, by
 *      reusing ServiceWorkerBridge.attach() with a postMessage adapter port.
 *
 * This makes the mobile hot path work where service workers are unreliable
 * (iOS Chrome). React Refresh (HMR) rides the WebSocket shim → parent → in-VM
 * ws server, exactly like the SW path.
 */
import { ServiceWorkerBridge } from '@lifo-sh/core';
import type { Kernel } from '@lifo-sh/core';

interface VmResponse { status: number; headers: Record<string, string>; body: Uint8Array }

/** Call a bound in-VM port directly (no SW) and await its full response. */
function vmFetch(kernel: Kernel, port: number, url: string, timeoutMs = 120000): Promise<VmResponse> {
  const handler = kernel.portRegistry.get(port);
  if (!handler) return Promise.resolve({ status: 502, headers: {}, body: new Uint8Array() });
  const vRes: {
    statusCode: number; headers: Record<string, string>; body: string;
    bodyBytes?: Uint8Array; _donePromise?: Promise<unknown>;
  } = { statusCode: 200, headers: {}, body: '' };
  handler({ method: 'GET', url, headers: { host: `localhost:${port}` }, body: '' }, vRes);
  const finish = (): VmResponse => ({
    status: vRes.statusCode,
    headers: vRes.headers,
    body: vRes.bodyBytes ?? new TextEncoder().encode(vRes.body || ''),
  });
  if (vRes._donePromise) {
    return Promise.race([
      vRes._donePromise.then(finish),
      new Promise<VmResponse>((resolve) => setTimeout(() => resolve({ status: 504, headers: {}, body: new Uint8Array() }), timeoutMs)),
    ]);
  }
  return Promise.resolve(finish());
}

/**
 * Injected into the preview HTML (as a classic inline script, before the bundle)
 * so it runs first. Tunnels the app's runtime fetch/XHR/WebSocket to the parent
 * over window.postMessage. `__LIFO_PORT` is stamped in by the host.
 */
export function shimScript(port: number): string {
  return `(function(){
  var PORT=${port};
  var parentWin=window.parent, seq=0, pending=new Map(), wsConns=new Map();
  function b64enc(u8){var s='';for(var i=0;i<u8.length;i++)s+=String.fromCharCode(u8[i]);return btoa(s);}
  function b64dec(b){var s=atob(b),u=new Uint8Array(s.length);for(var i=0;i<s.length;i++)u[i]=s.charCodeAt(i);return u;}
  window.addEventListener('message',function(e){
    if(e.source!==parentWin)return; var m=e.data||{};
    if(m.type==='response'){var p=pending.get(m.requestId);if(p){pending.delete(m.requestId);p(m);}}
    else if(m.connId){var c=wsConns.get(m.connId);if(!c)return;
      if(m.type==='ws-opened')c.__open();
      else if(m.type==='ws-message')c.__msg(m.data,m.binary);
      else if(m.type==='ws-close'){wsConns.delete(m.connId);c.__close(1006,'');}}
  });
  // Which URLs tunnel to the VM: relative, root-absolute, or our own host.
  function tunnelable(u){ if(!u)return false; if(/^(blob:|data:)/.test(u))return false;
    if(u[0]==='/')return true; try{var url=new URL(u); return url.host==='localhost:'+PORT||url.host===location.host;}catch(_){return u[0]==='.';} }
  function pathOf(u){ if(u[0]==='/')return u; try{return new URL(u).pathname+new URL(u).search;}catch(_){return u;} }
  function vmreq(method,url,headers,body){ return new Promise(function(res){ var id='r'+(seq++);
    // Normalize headers (Headers instance / [k,v][] / object) to a plain object.
    var h={}; if(headers){ if(typeof headers.forEach==='function'&&!Array.isArray(headers)){headers.forEach(function(v,k){h[k]=v;});} else if(Array.isArray(headers)){headers.forEach(function(p){h[p[0]]=p[1];});} else {for(var k in headers)h[k]=headers[k];} }
    // Restore Content-Length so in-VM body parsers (body-parser/express.json,
    // whose hasBody() needs it) parse POST/PUT bodies. fetch/XHR omit it.
    if(body&&body.length&&h['content-length']==null&&h['Content-Length']==null)h['content-length']=String(body.length);
    pending.set(id,res); parentWin.postMessage({type:'request',requestId:id,port:PORT,method:method,url:pathOf(url),headers:h,body:body?b64enc(body):''},'*'); }); }
  // --- fetch shim ---
  var origFetch=window.fetch;
  window.fetch=function(input,init){ var url=typeof input==='string'?input:(input&&input.url);
    if(!tunnelable(url))return origFetch.apply(this,arguments);
    var method=(init&&init.method)||'GET'; var body=init&&init.body; var bytes=null;
    if(typeof body==='string')bytes=new TextEncoder().encode(body);
    return vmreq(method,url,(init&&init.headers)||{},bytes).then(function(m){
      var buf=m.bodyBuffer||(m.body?b64dec(m.body).buffer:new ArrayBuffer(0));
      return new Response(buf,{status:m.statusCode||200,headers:m.headers||{}}); }); };
  // --- image asset interceptor ---
  // RNW builds /assets/… URLs at RENDER time; the browser would load them from
  // the blob origin (no server, no SW) and 404. Route via the (shimmed) fetch →
  // blob → swap the real src.
  (function(){
    var proto=window.HTMLImageElement&&HTMLImageElement.prototype; if(!proto)return;
    var d=Object.getOwnPropertyDescriptor(proto,'src');
    if(d&&d.set){ Object.defineProperty(proto,'src',{configurable:true,enumerable:d.enumerable,
      get:function(){return d.get.call(this);},
      set:function(v){ var img=this; if(typeof v==='string'&&tunnelable(v)){ window.fetch(v).then(function(r){return r.ok?r.blob():null;}).then(function(b){ d.set.call(img,b?URL.createObjectURL(b):v); }).catch(function(){ d.set.call(img,v); }); } else { d.set.call(this,v); } }
    }); }
    var os=proto.setAttribute; proto.setAttribute=function(n,val){ if(n==='src'){ this.src=val; return; } return os.call(this,n,val); };
  })();
  // --- font interceptor (expo-font / @expo/vector-icons) ---
  // FontFace.load() fetches its url() with the BROWSER (bypassing our fetch
  // shim) → 404. Fetch the bytes via the bridge and build the face from an
  // ArrayBuffer instead.
  (function(){
    var Orig=window.FontFace; if(!Orig)return;
    function Patched(family,source,desc){
      if(typeof source==='string'){ var m=source.match(/url\\(\\s*['"]?([^'")]+)['"]?\\s*\\)/);
        if(m&&tunnelable(m[1])){ var url=m[1]; var ff=new Orig(family,'url(about:blank)',desc||{});
          ff.load=function(){ return window.fetch(url).then(function(r){return r.arrayBuffer();}).then(function(buf){ var real=new Orig(family,buf,desc||{}); try{document.fonts.add(real);}catch(_){}; return real.load(); }); };
          return ff; } }
      return new Orig(family,source,desc);
    }
    Patched.prototype=Orig.prototype;
    try{ window.FontFace=Patched; }catch(_){}
  })();
  // --- CSS @font-face interceptor (@expo/vector-icons) ---
  // vector-icons injects a <style> with @font-face{src:url(/assets/…ttf)} and
  // lets the BROWSER load the url — bypassing fetch/FontFace shims → 404 → tofu.
  // Rewrite such urls to bridge-fetched blob: URLs on the fly.
  (function(){
    function rewrite(styleEl){
      try{ var css=styleEl.textContent||''; if(css.indexOf('@font-face')<0&&css.indexOf('url(')<0)return;
        var urls=[]; css.replace(/url\\(\\s*['"]?([^'")]+)['"]?\\s*\\)/g,function(_m,u){ if(tunnelable(u)&&urls.indexOf(u)<0)urls.push(u); return _m; });
        if(!urls.length)return; if(styleEl.__lifoRw)return; styleEl.__lifoRw=1;
        var map={},pending=urls.length;
        urls.forEach(function(u){ window.fetch(u).then(function(r){return r.ok?r.blob():null;}).then(function(b){ if(b)map[u]=URL.createObjectURL(b); }).catch(function(){}).then(function(){ if(--pending===0){ var out=css; Object.keys(map).forEach(function(u){ out=out.split(u).join(map[u]); }); if(styleEl.textContent!==out)styleEl.textContent=out; } }); });
      }catch(_){}
    }
    var ap=Node.prototype.appendChild;
    Node.prototype.appendChild=function(node){ var r=ap.call(this,node); try{ if(node&&node.tagName==='STYLE')rewrite(node); else if(this&&this.tagName==='STYLE')rewrite(this); }catch(_){}; return r; };
    var ib=Node.prototype.insertBefore;
    Node.prototype.insertBefore=function(node,ref){ var r=ib.call(this,node,ref); try{ if(node&&node.tagName==='STYLE')rewrite(node); }catch(_){}; return r; };
  })();
  // --- XHR shim (RN's networking uses XHR) ---
  var OrigXHR=window.XMLHttpRequest;
  function ShimXHR(){ this._h={}; this.readyState=0; this.status=0; this.response=''; this.responseText=''; this.onload=null; this.onreadystatechange=null; this.onerror=null; }
  ShimXHR.prototype.open=function(m,u){ this._m=m; this._u=u; if(!tunnelable(u)){this._native=new OrigXHR();this._native.open.apply(this._native,arguments);} };
  ShimXHR.prototype.setRequestHeader=function(k,v){ if(this._native)return this._native.setRequestHeader(k,v); this._h[k]=v; };
  ShimXHR.prototype.send=function(body){ var self=this; if(this._native){['onload','onerror','onreadystatechange'].forEach(function(k){self._native[k]=function(){self.status=self._native.status;self.responseText=self._native.responseText;self.response=self._native.response;self.readyState=self._native.readyState;self[k]&&self[k]();};});return this._native.send(body);}
    var bytes=typeof body==='string'?new TextEncoder().encode(body):null;
    vmreq(this._m,this._u,this._h,bytes).then(function(m){ var buf=m.bodyBuffer||(m.body?b64dec(m.body).buffer:new ArrayBuffer(0));
      self.status=m.statusCode||200; self.response=buf; self.responseText=new TextDecoder().decode(new Uint8Array(buf)); self.readyState=4;
      self.onreadystatechange&&self.onreadystatechange(); self.onload&&self.onload(); }); };
  ShimXHR.prototype.getAllResponseHeaders=function(){return '';}; ShimXHR.prototype.getResponseHeader=function(){return null;}; ShimXHR.prototype.abort=function(){};
  window.XMLHttpRequest=ShimXHR;
  // --- WebSocket shim (HMR / React Refresh) ---
  var OrigWS=window.WebSocket;
  function LifoWS(url,protocols){
    var raw=String(url), pathSearch=null;
    // Metro in a blob: iframe builds ws:///hot and ws:///message — window.location.host
    // is '' in a blob document, so the URL has an empty authority (three slashes).
    // Host detection is unreliable there (Node reads the path as the host; browsers
    // vary), so match the raw string and tunnel to the preview PORT.
    if(/^wss?:\\/\\/\\//i.test(raw)){ pathSearch=raw.replace(/^wss?:\\/\\//i,''); if(pathSearch.charAt(0)!=='/')pathSearch='/'+pathSearch; }
    else { var u=null; try{u=new URL(raw,location.href);}catch(_){}
      if(u&&(u.protocol==='ws:'||u.protocol==='wss:')&&(u.host==='localhost:'+PORT||u.host===location.host))pathSearch=u.pathname+u.search;
      else return new OrigWS(url,protocols); }
    var self=this;
    this.url=raw; this.readyState=0; this.bufferedAmount=0; this.protocol=Array.isArray(protocols)?(protocols[0]||''):(protocols||''); this.binaryType='blob';
    this.onopen=null;this.onmessage=null;this.onclose=null;this.onerror=null; this._l={open:[],message:[],close:[],error:[]};
    this.connId='ws'+(seq++); wsConns.set(this.connId,this);
    parentWin.postMessage({type:'ws-open',connId:this.connId,port:PORT,url:pathSearch,protocol:this.protocol},'*');
    this.__open=function(){self.readyState=1;self.__emit('open',{});};
    this.__msg=function(b64,binary){var data;if(binary){var buf=b64dec(b64).buffer;data=self.binaryType==='arraybuffer'?buf:new Blob([buf]);}else{data=new TextDecoder().decode(b64dec(b64));}self.__emit('message',{data:data});};
    this.__close=function(code,reason){if(self.readyState===3)return;self.readyState=3;self.__emit('close',{code:code||1000,reason:reason||'',wasClean:code===1000});};
    this.__emit=function(type,init){var ev;try{ev=type==='message'?new MessageEvent('message',init):new (type==='close'?CloseEvent:Event)(type,init);}catch(_){ev={type:type};for(var k in init)ev[k]=init[k];}var h=self['on'+type];if(h)try{h.call(self,ev);}catch(_){}(self._l[type]||[]).forEach(function(fn){try{fn.call(self,ev);}catch(_){}});};
  }
  LifoWS.prototype.send=function(data){var u8;if(typeof data==='string')u8=new TextEncoder().encode(data);else if(data instanceof ArrayBuffer)u8=new Uint8Array(data);else if(ArrayBuffer.isView(data))u8=new Uint8Array(data.buffer,data.byteOffset,data.byteLength);else u8=new TextEncoder().encode(String(data));parentWin.postMessage({type:'ws-send',connId:this.connId,data:b64enc(u8),binary:typeof data!=='string'},'*');};
  LifoWS.prototype.close=function(code,reason){if(this.readyState>=2)return;this.readyState=2;parentWin.postMessage({type:'ws-close',connId:this.connId},'*');this.__close(code||1000,reason||'');};
  LifoWS.prototype.addEventListener=function(t,fn){if(this._l[t])this._l[t].push(fn);};
  LifoWS.prototype.removeEventListener=function(t,fn){if(this._l[t]){var i=this._l[t].indexOf(fn);if(i>=0)this._l[t].splice(i,1);}};
  LifoWS.prototype.dispatchEvent=function(){return true;};
  LifoWS.CONNECTING=0;LifoWS.OPEN=1;LifoWS.CLOSING=2;LifoWS.CLOSED=3;
  window.WebSocket=LifoWS;
})();`;
}

/**
 * Router shim (ported from browser-metro). blob: documents can't change
 * location.pathname, so client routers (Expo Router / React Navigation) see the
 * blob UUID and render "Unmatched Route". This virtualizes document.URL, the URL
 * constructor, and the History stack, carrying the real route in location.hash
 * so the router reads a clean "/" path. Runs before the bundle.
 */
export function routerShim(bundleBlob: string, realBundlePath: string): string {
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
    // Metro reads document.currentScript.src (our bundle blob) to build its HMR
    // entry point — map that blob back to the real bundle URL so register-entrypoints
    // matches the in-VM graph. Other blob: URLs are the virtual document route.
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

export interface NoSwPreviewHandle { destroy(): void }

/**
 * Mount a service-worker-free preview of an in-VM dev server into `iframe`.
 * Returns a handle whose destroy() revokes blob URLs and detaches the bridge.
 */
export async function mountNoSwPreview(iframe: HTMLIFrameElement, kernel: Kernel, port: number): Promise<NoSwPreviewHandle> {
  const blobUrls: string[] = [];
  const mkBlob = (bytes: Uint8Array, type: string) => { const u = URL.createObjectURL(new Blob([bytes as BlobPart], { type })); blobUrls.push(u); return u; };

  // 0. Wait for the dev server to bind + serve a real page (user runs it in the
  //    terminal). x-lifo: no-server marks "port not bound yet".
  const deadline = Date.now() + 180000;
  let htmlRes = await vmFetch(kernel, port, '/');
  while ((htmlRes.status !== 200 || htmlRes.headers['x-lifo'] === 'no-server') && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 800));
    htmlRes = await vmFetch(kernel, port, '/');
  }

  // 1. App HTML from the dev server.
  let html = new TextDecoder().decode(htmlRes.body);

  // 2. Find the bundle <script src>, fetch it, rewrite static asset URLs to blobs.
  //    We load the bundle from a blob: URL, so `document.currentScript.src` becomes
  //    that blob. Metro derives its HMR entry point from currentScript.src
  //    (getFullBundlerUrl), so we remember the REAL bundle path and map the blob
  //    back to it in the router shim — otherwise register-entrypoints sends a blob:
  //    URL Metro can't match and no HMR updates are ever pushed.
  let bundleBlob = '';
  let realBundlePath = '';
  const scriptMatch = html.match(/<script\s+src=["']([^"']+\.bundle[^"']*)["']/i);
  if (scriptMatch) {
    realBundlePath = scriptMatch[1].startsWith('/') ? scriptMatch[1] : '/' + scriptMatch[1];
    const bundleRes = await vmFetch(kernel, port, realBundlePath);
    // Assets are handled at RUNTIME (img.src / FontFace interceptors in the
    // shim) — RN builds /assets/ URLs at render time from registry metadata, so
    // static bundle-string rewriting would only catch fragments.
    bundleBlob = mkBlob(bundleRes.body, 'application/javascript');
    html = html.replace(scriptMatch[0], `<script src="${bundleBlob}"`);
  }

  // 3. Inject the router shim (URL virtualization) then the transport shim,
  //    both before the bundle so they run first.
  html = html.replace(/<head(\s[^>]*)?>/i, (h) => `${h}\n<script>${routerShim(bundleBlob, realBundlePath)}</script>\n<script>${shimScript(port)}</script>`);

  // 4. Serve the HTML as a blob and point the iframe at it.
  const htmlBlob = mkBlob(new TextEncoder().encode(html), 'text/html');

  // 5. Reuse ServiceWorkerBridge with a postMessage adapter "port".
  const bridge = new ServiceWorkerBridge(kernel.portRegistry);
  const adapter = {
    postMessage: (msg: unknown, transfer?: Transferable[]) => iframe.contentWindow?.postMessage(msg, '*', transfer ?? []),
    onmessage: null as ((e: MessageEvent) => void) | null,
    start() {}, close() {},
  };
  const onWindowMessage = (e: MessageEvent) => { if (e.source === iframe.contentWindow) adapter.onmessage?.(e); };
  window.addEventListener('message', onWindowMessage);
  bridge.attach(adapter as unknown as MessagePort);

  iframe.src = htmlBlob;

  return {
    destroy() {
      window.removeEventListener('message', onWindowMessage);
      try { bridge.destroy(); } catch { /* ignore */ }
      for (const u of blobUrls) URL.revokeObjectURL(u);
    },
  };
}
