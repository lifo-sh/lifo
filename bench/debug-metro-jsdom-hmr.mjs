#!/usr/bin/env node
/**
 * debug-metro-jsdom-hmr.mjs — reproduce issue 2 with the REAL Metro web runtime.
 *
 * Boots `expo start --web` in the VM, then runs the actual served bundle under
 * jsdom with a WebSocket shim tunneled through ServiceWorkerBridge (the exact
 * transport the preview uses) and a fetch shim tunneled to the VM portRegistry.
 * Then edits App TWICE and checks whether the jsdom DOM reflects each edit.
 *
 * If DOM shows V1 but not V2 -> the real Metro HMR runtime fails to APPLY the
 * 2nd update (in-bundle/runtime bug). If both -> browser-only, not the runtime.
 */
import http from 'node:http';
import { createRequire } from 'node:module';
import { Sandbox, ServiceWorkerBridge } from '../packages/core/dist/index.js';
const require = createRequire('/tmp/bmrepro/');
const { JSDOM } = require('jsdom');

process.on('unhandledRejection', (e) => console.log('[REJ]', (e && e.message) || e));
const CORS = 8813, PORT = 8081, APP = '/home/user/my-app';
const out = (s) => process.stdout.write(s);
const log = (...a) => console.log('[t]', ...a);

// CORS proxy for the VM's own outbound package fetches.
const server = http.createServer((q, r) => { (async () => { const t = new URL(q.url, 'http://x').searchParams.get('url'); if (!t) { r.statusCode = 400; return r.end('x'); } const u = await fetch(t, { headers: { accept: '*/*', 'user-agent': 'lifo' } }); r.statusCode = u.status; r.end(Buffer.from(await u.arrayBuffer())); })().catch((e) => { r.statusCode = 502; r.end(e.message); }); });
await new Promise((r) => server.listen(CORS, r));

const sb = await Sandbox.create({ files: {}, cwd: '/home/user', persist: false, env: { LIFO_CORS_PROXY: `http://localhost:${CORS}/_cors?url=`, EXPO_NO_TELEMETRY: '1', BROWSER: 'none' } });
await sb.commands.run(`npx create-expo-app@latest ${APP} --template blank --no-install`, { cwd: '/home/user', onStdout: out, onStderr: out, timeout: 300000 });
await sb.commands.run('npm install', { cwd: APP, onStdout: out, onStderr: out, timeout: 600000 });
const reactPkgRaw = sb.kernel.vfs.readFile(`${APP}/node_modules/react/package.json`);
const reactVer = JSON.parse(typeof reactPkgRaw === 'string' ? reactPkgRaw : new TextDecoder().decode(reactPkgRaw)).version;
log('react version:', reactVer);
await sb.commands.run(`npm install react-dom@${reactVer} react-native-web@~0.21.0`, { cwd: APP, onStdout: out, onStderr: out, timeout: 600000 });
sb.shell.execute(`node ${APP}/node_modules/expo/bin/cli start --web ${APP}`, { cwd: APP, env: { ...sb.env, EXPO_OFFLINE: '1' }, onStdout: out, onStderr: out }).catch(() => {});
for (let i = 0; i < 300; i++) { if (sb.kernel.portRegistry.has(PORT)) break; await new Promise((r) => setTimeout(r, 400)); }
if (!sb.kernel.portRegistry.has(PORT)) { console.log('port never bound'); process.exit(2); }
log('port bound.');

// vm request helper (same contract debug-metro-hmr.mjs proved works).
const vmReq = (url, method = 'GET') => new Promise((res) => { const h = sb.kernel.portRegistry.get(PORT); const v = { statusCode: 200, headers: {}, body: '' }; h({ method, url, headers: { host: `localhost:${PORT}` }, body: '' }, v); v._donePromise ? v._donePromise.then(() => res(v)) : res(v); });
const bodyOf = (v) => (v.bodyBytes ? new TextDecoder().decode(v.bodyBytes) : (typeof v.body === 'string' ? v.body : new TextDecoder().decode(v.body || new Uint8Array())));

const home = await vmReq('/');
const homeHtml = bodyOf(home);
const m = homeHtml.match(/<script\s+src=["']([^"']+\.bundle[^"']*)["']/i);
let bundleUrl = m ? m[1] : '/index.bundle?platform=web&dev=true';
bundleUrl = /hot=false/.test(bundleUrl) ? bundleUrl.replace('hot=false', 'hot=true') : (/hot=/.test(bundleUrl) ? bundleUrl : bundleUrl + '&hot=true');
log('bundle url (hot forced):', bundleUrl);
const bres = await vmReq(bundleUrl);
const bundle = bodyOf(bres);
log('bundle bytes:', bundle.length);

// ── jsdom with bridge-backed WebSocket + VM-backed fetch ──
const dom = new JSDOM(homeHtml.replace(/<script[^>]*\.bundle[^>]*><\/script>/i, ''), { runScripts: 'outside-only', pretendToBeVisual: true, url: `http://localhost:${PORT}/` });
const { window } = dom;
if (!window.document.getElementById('root')) { const d = window.document.createElement('div'); d.id = 'root'; window.document.body.appendChild(d); }
const errors = [];
window.onerror = (msg, s, l, c, err) => errors.push('onerror: ' + (err && err.stack ? err.stack.split('\n').slice(0, 3).join('\n') : msg));
window.addEventListener('unhandledrejection', (e) => errors.push('unhandledrejection: ' + (e.reason && e.reason.stack || e.reason)));

// fetch shim → VM portRegistry (same-origin) or real network otherwise.
window.fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input.url;
  try {
    const u = new URL(url, `http://localhost:${PORT}/`);
    if (u.host === `localhost:${PORT}`) {
      const v = await vmReq(u.pathname + u.search, (init && init.method) || 'GET');
      const body = bodyOf(v);
      return { ok: v.statusCode < 400, status: v.statusCode, headers: { get: () => null }, text: async () => body, json: async () => JSON.parse(body) };
    }
  } catch { /* fall through */ }
  return fetch(url, init);
};

// WebSocket shim → ServiceWorkerBridge (mirrors preview-nosw transport).
const bridge = new ServiceWorkerBridge(sb.kernel.portRegistry);
const wsByConn = new Map();
let phase = 'init';
const inboundLog = [];
const adapter = {
  onmessage: null,
  // async delivery mirrors real window.postMessage (never synchronous inside
  // the WebSocket constructor), so the client assigns .onopen before it fires.
  postMessage: (msg) => setTimeout(() => {
    const ws = wsByConn.get(msg.connId);
    if (!ws) return;
    if (msg.type === 'ws-opened') { ws.readyState = 1; ws.onopen && ws.onopen({ type: 'open' }); (ws._l.open || []).forEach((f) => f({ type: 'open' })); }
    else if (msg.type === 'ws-message') {
      const data = msg.binary ? Buffer.from(msg.data, 'base64').buffer : Buffer.from(msg.data, 'base64').toString('utf8');
      // record the frame TYPE the /hot client receives, tagged by phase
      const path = (() => { try { return new URL(ws.url).pathname; } catch { return '?'; } })();
      let t = '<bin>'; if (typeof data === 'string') { try { t = JSON.parse(data).type; } catch { t = data.slice(0, 20); } }
      inboundLog.push(`${phase} ${path} <- ${t}`);
      const ev = { data }; ws.onmessage && ws.onmessage(ev); (ws._l.message || []).forEach((f) => f(ev));
    }
    else if (msg.type === 'ws-close') { ws.readyState = 3; ws.onclose && ws.onclose({ code: 1006 }); (ws._l.close || []).forEach((f) => f({ code: 1006 })); }
  }, 0),
  start() {}, close() {},
};
bridge.attach(adapter);
const bridgeOnMsg = adapter.onmessage;
adapter.onmessage = (e) => { const m = e.data; if (m && (m.type === 'ws-open' || m.type === 'ws-send' || m.type === 'ws-close')) { let t = ''; if (m.type === 'ws-send') { try { t = JSON.parse(Buffer.from(m.data, 'base64').toString('utf8')).type; } catch { t = '<bin/parse>'; } } inboundLog.push(`${phase} ${m.type}${t ? ' ' + t : ''} conn=${m.connId}${m.url ? ' ' + m.url : ''}`); } return bridgeOnMsg(e); };
let wsSeq = 0;
class LifoWS {
  constructor(url) { const u = new URL(url, `http://localhost:${PORT}/`); this.url = u.href; this.readyState = 0; this.onopen = this.onmessage = this.onclose = this.onerror = null; this._l = { open: [], message: [], close: [], error: [] }; this.connId = 'ws' + (wsSeq++); wsByConn.set(this.connId, this); adapter.onmessage({ data: { type: 'ws-open', connId: this.connId, port: PORT, url: u.pathname + u.search, protocol: '' } }); }
  send(data) { const u8 = typeof data === 'string' ? new TextEncoder().encode(data) : new Uint8Array(data.buffer || data); adapter.onmessage({ data: { type: 'ws-send', connId: this.connId, data: Buffer.from(u8).toString('base64'), binary: typeof data !== 'string' } }); }
  close() { if (this.readyState >= 2) return; this.readyState = 2; adapter.onmessage({ data: { type: 'ws-close', connId: this.connId } }); }
  addEventListener(t, fn) { (this._l[t] || (this._l[t] = [])).push(fn); }
  removeEventListener(t, fn) { const a = this._l[t]; if (a) { const i = a.indexOf(fn); if (i >= 0) a.splice(i, 1); } }
}
LifoWS.CONNECTING = 0; LifoWS.OPEN = 1; LifoWS.CLOSING = 2; LifoWS.CLOSED = 3;
window.WebSocket = LifoWS;

// run the bundle
try { window.eval(bundle); } catch (e) { errors.push('THROW: ' + (e.stack || e.message).split('\n').slice(0, 5).join('\n')); }
await new Promise((r) => setTimeout(r, 3000));
const rootText = () => (window.document.getElementById('root')?.textContent || '');
log('initial render text:', JSON.stringify(rootText().slice(0, 120)));
log('ws connections opened:', wsByConn.size, [...wsByConn.values()].map((w) => new URL(w.url).pathname));

async function edit(marker, ph) {
  phase = ph;
  sb.kernel.vfs.writeFile(`${APP}/App.js`, `import { Text, View } from 'react-native';\nexport default function App(){ return (<View><Text>${marker}</Text></View>); }\n`);
  for (let i = 0; i < 30; i++) { await new Promise((r) => setTimeout(r, 300)); if (rootText().includes(marker)) return true; }
  return false;
}

log('--- EDIT #1 (JSDOM_V1) ---');
const ok1 = await edit('JSDOM_V1', 'edit1');
log('edit#1 reflected in DOM:', ok1, '| text:', JSON.stringify(rootText().slice(0, 120)));
log('--- EDIT #2 (JSDOM_V2) ---');
const ok2 = await edit('JSDOM_V2', 'edit2');
log('edit#2 reflected in DOM:', ok2, '| text:', JSON.stringify(rootText().slice(0, 120)));

console.log('\n===== /hot + /message inbound frame timeline =====');
console.log(inboundLog.join('\n'));

console.log('\n===== errors =====');
console.log(errors.length ? errors.slice(0, 4).join('\n---\n') : '(none)');
console.log('\n===== VERDICT =====');
console.log('edit#1 applied (live HMR):', ok1);
console.log('edit#2 applied (live HMR):', ok2);
console.log(ok1 && !ok2 ? '>>> REPRODUCED: real Metro runtime applies #1 but NOT #2 (in-runtime bug)'
  : ok1 && ok2 ? '>>> Both applied — issue 2 is browser-only (jsdom cannot repro)'
  : '>>> Neither applied — jsdom cannot run Metro React Refresh (inconclusive)');
server.close();
process.exit(0);
