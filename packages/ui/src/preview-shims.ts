/**
 * preview-shims.ts — the code injected INTO a preview document so an app's
 * network calls reach servers running inside the VM.
 *
 * These are monkey patches on `fetch`, `XMLHttpRequest`, `WebSocket` and a few
 * asset-loading paths. They exist because a `blob:` (or otherwise server-less)
 * document has nothing to serve `/api/…` or `ws://…/hot` — so we intercept and
 * tunnel to the parent window over `postMessage`, where a
 * `ServiceWorkerBridge` answers from the kernel's port registry.
 *
 * WHY THIS IS SPLIT UP: the whole thing used to be one 130-line template
 * literal. Each piece here is independently composable, so a host embedding Lifo
 * can take only what it needs:
 *
 * ```ts
 * // everything (what mountNoSwPreview uses)
 * buildPreviewShim({ port: 8081, hostOrigin: location.origin })
 *
 * // just HTTP — no ws, no asset interception
 * buildPreviewShim({ port: 3000, include: ['fetch', 'xhr'] })
 * ```
 *
 * The transport is deliberately NOT baked in: `transport` picks how a request
 * leaves the document, so the same shims work over `postMessage` today and over
 * a `MessagePort` or a direct in-page call later.
 *
 * ── contract with the parent ────────────────────────────────────────────────
 * Outbound: `{type:'request', requestId, port, method, url, headers, body}` with
 * a base64 body; `{type:'ws-open'|'ws-send'|'ws-close', connId, …}`.
 * Inbound:  `{type:'response', requestId, statusCode, headers, body|bodyBuffer}`;
 * `{type:'ws-opened'|'ws-message'|'ws-close', connId, …}`.
 * These are the same shapes the service worker and the tunnel relay use, so all
 * three transports are interchangeable on the parent side.
 */

import { resolveVmTarget } from './vm-routing.js';

/** Individually selectable patches. */
export type ShimName = 'fetch' | 'xhr' | 'websocket' | 'images' | 'fonts' | 'css';

export const ALL_SHIMS: ShimName[] = ['fetch', 'xhr', 'websocket', 'images', 'fonts', 'css'];

export interface PreviewShimOptions {
  /** In-VM port backing the preview document; the default for relative URLs. */
  port: number;
  /**
   * Origin of the EMBEDDING page — pass `location.origin` from the parent
   * document. Needed both to recognise the embedder's own assets (they must
   * reach the real network) and to accept a `/_sw/<port>/` prefix on its origin
   * as ours to route. It cannot be read inside the preview: a `blob:` document
   * reports `location.host` as the empty string.
   */
  hostOrigin?: string;
  /** Which patches to install. Defaults to all of them. */
  include?: ShimName[];
  /** How a request leaves the document. Defaults to `postMessage` to the parent. */
  transport?: 'postMessage';
}

/**
 * Runtime every shim needs: the transport, request correlation, base64 helpers,
 * and `resolveTarget` (inlined from the real `resolveVmTarget` so the sandboxed
 * copy and the unit-tested copy cannot drift).
 */
function runtime(port: number, hostOrigin: string): string {
  return `
  var PORT=${port}, HOST_ORIGIN=${JSON.stringify(hostOrigin)};
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
  // Inlined verbatim from vm-routing.ts — same function, here and in its tests.
  var resolveVmTarget=${resolveVmTarget.toString()};
  function resolveTarget(u){ return resolveVmTarget(u,PORT,HOST_ORIGIN); }
  // "Does this go to the VM?" — for patches that re-enter through window.fetch,
  // which resolves the port itself.
  function tunnelable(u){ return resolveTarget(u)!==null; }
  function toBytes(body){
    if(typeof body==='string')return new TextEncoder().encode(body);
    if(body instanceof Uint8Array)return body;
    if(body instanceof ArrayBuffer)return new Uint8Array(body);
    if(body&&ArrayBuffer.isView(body))return new Uint8Array(body.buffer,body.byteOffset,body.byteLength);
    return null;
  }
  function vmreq(target,method,headers,body){ return new Promise(function(res){ var id='r'+(seq++);
    // Normalize headers (Headers instance / [k,v][] / plain object).
    var h={}; if(headers){ if(typeof headers.forEach==='function'&&!Array.isArray(headers)){headers.forEach(function(v,k){h[k]=v;});} else if(Array.isArray(headers)){headers.forEach(function(p){h[p[0]]=p[1];});} else {for(var k in headers)h[k]=headers[k];} }
    // Restore Content-Length: in-VM body parsers (body-parser/express.json,
    // whose hasBody() requires it) skip parsing without it, and fetch/XHR omit it.
    if(body&&body.length&&h['content-length']==null&&h['Content-Length']==null)h['content-length']=String(body.length);
    pending.set(id,res); parentWin.postMessage({type:'request',requestId:id,port:target.port,method:method,url:target.path,headers:h,body:body?b64enc(body):''},'*'); }); }
  function toResponse(m){
    var st=m.statusCode||200; var buf=m.bodyBuffer||(m.body?b64dec(m.body).buffer:new ArrayBuffer(0));
    // 204/205/304 are null-body statuses — Response throws if given a body.
    var nb=st===204||st===205||st===304;
    return new Response(nb?null:buf,{status:st,headers:m.headers||{}});
  }`;
}

/** Patch `window.fetch`. Non-VM URLs fall through to the original. */
function fetchShim(): string {
  return `
  var origFetch=window.fetch;
  window.fetch=function(input,init){ var url=typeof input==='string'?input:(input&&input.url);
    var target=resolveTarget(url);
    if(!target)return origFetch.apply(this,arguments);
    var method=(init&&init.method)||'GET';
    return vmreq(target,method,(init&&init.headers)||{},toBytes(init&&init.body)).then(toResponse); };`;
}

/** Patch `XMLHttpRequest` — React Native's networking layer uses it. */
function xhrShim(): string {
  return `
  var OrigXHR=window.XMLHttpRequest;
  function ShimXHR(){ this._h={}; this.readyState=0; this.status=0; this.response=''; this.responseText=''; this.onload=null; this.onreadystatechange=null; this.onerror=null; }
  ShimXHR.prototype.open=function(m,u){ this._m=m; this._u=u; this._t=resolveTarget(u); if(!this._t){this._native=new OrigXHR();this._native.open.apply(this._native,arguments);} };
  ShimXHR.prototype.setRequestHeader=function(k,v){ if(this._native)return this._native.setRequestHeader(k,v); this._h[k]=v; };
  ShimXHR.prototype.send=function(body){ var self=this; if(this._native){['onload','onerror','onreadystatechange'].forEach(function(k){self._native[k]=function(){self.status=self._native.status;self.responseText=self._native.responseText;self.response=self._native.response;self.readyState=self._native.readyState;self[k]&&self[k]();};});return this._native.send(body);}
    vmreq(this._t,this._m,this._h,toBytes(body)).then(function(m){ var buf=m.bodyBuffer||(m.body?b64dec(m.body).buffer:new ArrayBuffer(0));
      self.status=m.statusCode||200; self.response=buf; self.responseText=new TextDecoder().decode(new Uint8Array(buf)); self.readyState=4;
      self.onreadystatechange&&self.onreadystatechange(); self.onload&&self.onload(); }); };
  ShimXHR.prototype.getAllResponseHeaders=function(){return '';}; ShimXHR.prototype.getResponseHeader=function(){return null;}; ShimXHR.prototype.abort=function(){};
  window.XMLHttpRequest=ShimXHR;`;
}

/**
 * Patch `WebSocket` — HMR (Vite/Metro) and supabase realtime.
 *
 * Realtime is why this resolves a port of its own: it opens
 * `ws://localhost:54321/realtime/v1/websocket` while the preview is on 8081.
 */
function webSocketShim(): string {
  return `
  var OrigWS=window.WebSocket;
  function LifoWS(url,protocols){
    var raw=String(url), pathSearch=null, wsPort=PORT;
    // Metro in a blob: iframe builds ws:///hot and ws:///message — location.host
    // is '' in a blob document, so the URL has an empty authority (three
    // slashes). Host detection is unreliable there (Node reads the path as the
    // host; browsers vary), so match the raw string and use the preview port.
    if(/^wss?:\\/\\/\\//i.test(raw)){ pathSearch=raw.replace(/^wss?:\\/\\//i,''); if(pathSearch.charAt(0)!=='/')pathSearch='/'+pathSearch; }
    else {
      var probe=raw.replace(/^ws:/i,'http:').replace(/^wss:/i,'https:');
      var t=/^wss?:/i.test(raw)||raw.charAt(0)==='/'||raw.charAt(0)==='.'?resolveTarget(probe):null;
      if(!t)return new OrigWS(url,protocols);
      wsPort=t.port; pathSearch=t.path;
    }
    var self=this;
    this.url=raw; this.readyState=0; this.bufferedAmount=0; this.protocol=Array.isArray(protocols)?(protocols[0]||''):(protocols||''); this.binaryType='blob';
    this.onopen=null;this.onmessage=null;this.onclose=null;this.onerror=null; this._l={open:[],message:[],close:[],error:[]};
    this.connId='ws'+(seq++); wsConns.set(this.connId,this);
    parentWin.postMessage({type:'ws-open',connId:this.connId,port:wsPort,url:pathSearch,protocol:this.protocol},'*');
    this.__open=function(){self.readyState=1;self.__emit('open',{});};
    this.__msg=function(b64,binary){var data;if(binary){var buf=b64dec(b64).buffer;data=self.binaryType==='arraybuffer'?buf:new Blob([buf]);}else{data=new TextDecoder().decode(b64dec(b64));}self.__emit('message',{data:data});};
    this.__close=function(code,reason){if(self.readyState===3)return;self.readyState=3;self.__emit('close',{code:code||1000,reason:reason||'',wasClean:code===1000});};
    this.__emit=function(type,init){var ev;try{ev=type==='message'?new MessageEvent('message',init):new (type==='close'?CloseEvent:Event)(type,init);}catch(_){ev={type:type};for(var k in init)ev[k]=init[k];}var h=self['on'+type];if(h)try{h.call(self,ev);}catch(_){}(self._l[type]||[]).forEach(function(fn){try{fn.call(self,ev);}catch(_){}});};
  }
  LifoWS.prototype.send=function(data){var u8=toBytes(data)||new TextEncoder().encode(String(data));parentWin.postMessage({type:'ws-send',connId:this.connId,data:b64enc(u8),binary:typeof data!=='string'},'*');};
  LifoWS.prototype.close=function(code,reason){if(this.readyState>=2)return;this.readyState=2;parentWin.postMessage({type:'ws-close',connId:this.connId},'*');this.__close(code||1000,reason||'');};
  LifoWS.prototype.addEventListener=function(t,fn){if(this._l[t])this._l[t].push(fn);};
  LifoWS.prototype.removeEventListener=function(t,fn){if(this._l[t]){var i=this._l[t].indexOf(fn);if(i>=0)this._l[t].splice(i,1);}};
  LifoWS.prototype.dispatchEvent=function(){return true;};
  LifoWS.CONNECTING=0;LifoWS.OPEN=1;LifoWS.CLOSING=2;LifoWS.CLOSED=3;
  window.WebSocket=LifoWS;`;
}

/**
 * Route `<img src>` through the shimmed fetch.
 *
 * React Native Web builds `/assets/…` URLs at RENDER time from registry
 * metadata, so the browser would load them from the document's own (server-less)
 * origin and 404. Static rewriting of the bundle can't catch them.
 */
function imageShim(): string {
  return `
  (function(){
    var proto=window.HTMLImageElement&&HTMLImageElement.prototype; if(!proto)return;
    var d=Object.getOwnPropertyDescriptor(proto,'src');
    if(d&&d.set){ Object.defineProperty(proto,'src',{configurable:true,enumerable:d.enumerable,
      get:function(){return d.get.call(this);},
      set:function(v){ var img=this; if(typeof v==='string'&&tunnelable(v)){ window.fetch(v).then(function(r){return r.ok?r.blob():null;}).then(function(b){ d.set.call(img,b?URL.createObjectURL(b):v); }).catch(function(){ d.set.call(img,v); }); } else { d.set.call(this,v); } }
    }); }
    var os=proto.setAttribute; proto.setAttribute=function(n,val){ if(n==='src'){ this.src=val; return; } return os.call(this,n,val); };
  })();`;
}

/**
 * Patch `FontFace` (expo-font / @expo/vector-icons).
 *
 * `FontFace.load()` fetches its `url()` with the BROWSER, bypassing the fetch
 * patch entirely → 404. Fetch the bytes over the bridge and build the face from
 * an ArrayBuffer instead.
 */
function fontFaceShim(): string {
  return `
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
  })();`;
}

/**
 * Rewrite `url()` inside injected `<style>` elements to bridge-fetched blobs.
 *
 * @expo/vector-icons injects `<style>@font-face{src:url(/assets/…ttf)}</style>`
 * and lets the browser load it — bypassing both the fetch and FontFace patches,
 * giving tofu boxes.
 */
function cssFontShim(): string {
  return `
  (function(){
    function rewrite(styleEl){
      try{ var css=styleEl.textContent||''; if(css.indexOf('@font-face')<0&&css.indexOf('url(')<0)return;
        var urls=[]; css.replace(/url\\(\\s*['"]?([^'")]+)['"]?\\s*\\)/g,function(_m,u){ if(tunnelable(u)&&urls.indexOf(u)<0)urls.push(u); return _m; });
        if(!urls.length)return; if(styleEl.__lifoRw)return; styleEl.__lifoRw=1;
        var map={},left=urls.length;
        urls.forEach(function(u){ window.fetch(u).then(function(r){return r.ok?r.blob():null;}).then(function(b){ if(b)map[u]=URL.createObjectURL(b); }).catch(function(){}).then(function(){ if(--left===0){ var out=css; Object.keys(map).forEach(function(u){ out=out.split(u).join(map[u]); }); if(styleEl.textContent!==out)styleEl.textContent=out; } }); });
      }catch(_){}
    }
    var ap=Node.prototype.appendChild;
    Node.prototype.appendChild=function(node){ var r=ap.call(this,node); try{ if(node&&node.tagName==='STYLE')rewrite(node); else if(this&&this.tagName==='STYLE')rewrite(this); }catch(_){}; return r; };
    var ib=Node.prototype.insertBefore;
    Node.prototype.insertBefore=function(node,ref){ var r=ib.call(this,node,ref); try{ if(node&&node.tagName==='STYLE')rewrite(node); }catch(_){}; return r; };
  })();`;
}

const FRAGMENTS: Record<ShimName, () => string> = {
  fetch: fetchShim,
  xhr: xhrShim,
  websocket: webSocketShim,
  images: imageShim,
  fonts: fontFaceShim,
  css: cssFontShim,
};

/**
 * Build the shim source to inject into a preview document, as a classic inline
 * script that must run BEFORE the app's bundle.
 *
 * The asset patches (`images`, `fonts`, `css`) re-enter through `window.fetch`,
 * so including them without `fetch` would leave them hitting the real network.
 */
export function buildPreviewShim(options: PreviewShimOptions): string {
  const { port, hostOrigin = '', include = ALL_SHIMS, transport = 'postMessage' } = options;
  if (transport !== 'postMessage') throw new Error(`preview shim: unsupported transport "${transport}"`);

  const wanted = ALL_SHIMS.filter((name) => include.includes(name));
  const needsFetch = wanted.some((n) => n === 'images' || n === 'fonts' || n === 'css');
  if (needsFetch && !wanted.includes('fetch')) {
    throw new Error("preview shim: the 'images'/'fonts'/'css' patches route through the patched fetch, so 'fetch' must be included too");
  }

  const body = wanted.map((name) => FRAGMENTS[name]()).join('\n');
  return `(function(){${runtime(port, String(hostOrigin || ''))}\n${body}\n})();`;
}
