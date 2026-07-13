#!/usr/bin/env node
/**
 * test-nosw-bridge.mjs — headless check of the SW-FREE transport's HOST half:
 * ServiceWorkerBridge driven by a postMessage adapter (what the parent window
 * does for the blob iframe). Simulates the iframe posting {type:'request'} and
 * asserts the bridge answers {type:'response'} from the in-VM Metro server.
 * (The iframe-side shims are browser-only and tested manually in the playground.)
 */
import { performance } from 'node:perf_hooks';
import http from 'node:http';
import { Sandbox, ServiceWorkerBridge } from '../packages/core/dist/index.js';

const T0 = performance.now();
const log = (...a) => console.log(`[${((performance.now() - T0) / 1000).toFixed(1)}s]`, ...a);
process.on('unhandledRejection', (e) => log('REJ:', e?.message || e));
const CORS = 8801, PORT = 8081, APP = '/home/user/my-app';
const server = http.createServer((req, res) => { (async () => { const t = new URL(req.url, 'http://localhost').searchParams.get('url'); if (!t) { res.statusCode = 400; return res.end('x'); } const up = await fetch(t, { headers: { accept: '*/*', 'user-agent': 'lifo' } }); res.statusCode = up.status; res.end(Buffer.from(await up.arrayBuffer())); })().catch((e) => { res.statusCode = 502; res.end(e.message); }); });
await new Promise((r) => server.listen(CORS, r));
const out = (s) => process.stdout.write(s);
const sb = await Sandbox.create({ files: {}, cwd: '/home/user', persist: false, env: { LIFO_CORS_PROXY: `http://localhost:${CORS}/_cors?url=`, EXPO_NO_TELEMETRY: '1', BROWSER: 'none' } });
const ro = { cwd: '/home/user', onStdout: out, onStderr: out, timeout: 600000 };
await sb.commands.run(`npx create-expo-app@latest ${APP} --template blank --no-install`, ro);
await sb.commands.run('npm install', { ...ro, cwd: APP });
await sb.commands.run('npm install react-dom react-native-web@~0.21.0', { ...ro, cwd: APP });
sb.shell.execute(`node ${APP}/node_modules/expo/bin/cli start --web ${APP}`, { cwd: APP, env: { ...sb.env, EXPO_OFFLINE: '1' }, onStdout: out, onStderr: out }).catch(() => {});
for (let i = 0; i < 300; i++) { if (sb.kernel.portRegistry.has(PORT)) break; await new Promise((r) => setTimeout(r, 400)); }
log('port bound:', sb.kernel.portRegistry.has(PORT));

// The postMessage adapter the parent uses in place of a real MessagePort.
// Match responses by requestId (requests can overlap / complete out of order).
const pending = new Map();
const adapter = {
  postMessage: (msg) => { if (msg?.type === 'response') { const r = pending.get(msg.requestId); if (r) { pending.delete(msg.requestId); r(msg); } } },
  onmessage: null,
  start() {}, close() {},
};

const bridge = new ServiceWorkerBridge(sb.kernel.portRegistry);
bridge.attach(adapter);
const iframeSend = (msg) => adapter.onmessage?.({ data: msg });

let idc = 0;
async function get(url) {
  const requestId = 'r' + (idc++);
  const p = new Promise((res) => { pending.set(requestId, res); setTimeout(() => { if (pending.delete(requestId)) res({ statusCode: 0 }); }, 90000); });
  iframeSend({ type: 'request', requestId, port: PORT, method: 'GET', url, headers: {}, body: '' });
  const r = await p;
  const bytes = r.bodyBuffer ? r.bodyBuffer.byteLength : 0;
  return { status: r.statusCode, bytes, text: r.bodyBuffer ? new TextDecoder().decode(new Uint8Array(r.bodyBuffer)) : '' };
}

log('request / via bridge+adapter…');
const html = await get('/');
log(`  / → ${html.status}, ${html.bytes} bytes`);
const m = html.text.match(/<script\s+src=["']([^"']+\.bundle[^"']*)["']/i);
const bundleUrl = m ? (m[1].startsWith('/') ? m[1] : '/' + m[1]) : null;
log('  bundle url:', bundleUrl);
let bundle = { status: 0, bytes: 0 };
if (bundleUrl) { bundle = await get(bundleUrl); log(`  bundle → ${bundle.status}, ${bundle.bytes} bytes`); }

const ok = html.status === 200 && html.text.includes('id="root"') && bundle.status === 200 && bundle.bytes > 500000;
console.log('\n========= SW-FREE HOST TRANSPORT =========');
console.log('HTML via adapter:', html.status, html.bytes, 'bytes, has #root:', html.text.includes('id="root"'));
console.log('bundle via adapter:', bundle.status, bundle.bytes, 'bytes');
console.log(ok ? '✅ PASS — bridge+postMessage adapter serves the app from the in-VM server (no SW)' : '❌ FAIL');
console.log('=========================================\n');
server.close();
process.exit(ok ? 0 : 1);
