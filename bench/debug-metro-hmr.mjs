#!/usr/bin/env node
/**
 * debug-metro-hmr.mjs — reproduce issue 2 (real Metro: 2nd edit doesn't HMR).
 * Connects to Metro's /hot ws via ServiceWorkerBridge, registers, edits App
 * TWICE, and logs the ws messages Metro pushes for each edit. If edit#1 pushes
 * updates but edit#2 doesn't → watcher/Metro side; if both push → delivery/client.
 */
import http from 'node:http';
import { Sandbox, ServiceWorkerBridge } from '../packages/core/dist/index.js';

process.on('unhandledRejection', (e) => console.log('[REJ]', (e && e.message) || e));
const CORS = 8812, PORT = 8081, APP = '/home/user/my-app';
const server = http.createServer((q, r) => { (async () => { const t = new URL(q.url, 'http://x').searchParams.get('url'); if (!t) { r.statusCode = 400; return r.end('x'); } const u = await fetch(t, { headers: { accept: '*/*', 'user-agent': 'lifo' } }); r.statusCode = u.status; r.end(Buffer.from(await u.arrayBuffer())); })().catch((e) => { r.statusCode = 502; r.end(e.message); }); });
await new Promise((r) => server.listen(CORS, r));
const out = (s) => process.stdout.write(s);
const log = (...a) => console.log('[t]', ...a);

const sb = await Sandbox.create({ files: {}, cwd: '/home/user', persist: false, env: { LIFO_CORS_PROXY: `http://localhost:${CORS}/_cors?url=`, EXPO_NO_TELEMETRY: '1', BROWSER: 'none' } });
await sb.commands.run(`npx create-expo-app@latest ${APP} --template blank --no-install`, { cwd: '/home/user', onStdout: out, onStderr: out, timeout: 300000 });
await sb.commands.run('npm install', { cwd: APP, onStdout: out, onStderr: out, timeout: 600000 });
await sb.commands.run('npm install react-dom react-native-web@~0.21.0', { cwd: APP, onStdout: out, onStderr: out, timeout: 600000 });
sb.shell.execute(`node ${APP}/node_modules/expo/bin/cli start --web ${APP}`, { cwd: APP, env: { ...sb.env, EXPO_OFFLINE: '1' }, onStdout: out, onStderr: out }).catch(() => {});
for (let i = 0; i < 300; i++) { if (sb.kernel.portRegistry.has(PORT)) break; await new Promise((r) => setTimeout(r, 400)); }
log('port bound; triggering first bundle…');
// GET / then the bundle so Metro builds the graph (needed before HMR registration).
const req = (url) => new Promise((res) => { const h = sb.kernel.portRegistry.get(PORT); const v = { statusCode: 200, headers: {}, body: '' }; h({ method: 'GET', url, headers: { host: `localhost:${PORT}` }, body: '' }, v); v._donePromise ? v._donePromise.then(() => res(v)) : res(v); });
const homeRes = await req('/');
const homeHtml = homeRes.bodyBytes ? new TextDecoder().decode(homeRes.bodyBytes) : homeRes.body;
const m = homeHtml.match(/<script\s+src=["']([^"']+\.bundle[^"']*)["']/i);
const bundleUrl = m ? m[1] : '/index.bundle?platform=web&dev=true';
log('exact bundle url:', bundleUrl);
await req(bundleUrl);
log('bundle built. opening /hot ws via bridge…');

// Bridge + postMessage adapter (same transport the preview uses).
const inbox = [];
const adapter = { postMessage: (m) => inbox.push(m), onmessage: null, start() {}, close() {} };
const bridge = new ServiceWorkerBridge(sb.kernel.portRegistry);
bridge.attach(adapter);
const send = (m) => adapter.onmessage?.({ data: m });
const CONN = 'c1';
let msgs = [];
// drain adapter inbox → collect ws-message
const drain = setInterval(() => { while (inbox.length) { const m = inbox.shift(); if (m.type === 'ws-opened') log('ws-opened'); else if (m.type === 'ws-message') { try { msgs.push(JSON.parse(atob(m.data))); } catch { msgs.push('<binary>'); } } else if (m.type === 'ws-close') log('ws-close'); } }, 50);

send({ type: 'ws-open', connId: CONN, port: PORT, url: '/hot', protocol: '' });
await new Promise((r) => setTimeout(r, 1000));
// register entry point (Metro HMRClient protocol)
const absEntry = `http://localhost:${PORT}${bundleUrl}`;
log('register entry:', absEntry);
send({ type: 'ws-send', connId: CONN, data: btoa(JSON.stringify({ type: 'register-entrypoints', entryPoints: [absEntry] })), binary: false });
await new Promise((r) => setTimeout(r, 1500));
log('after register, msgs:', msgs.map((m) => m && m.type));

async function edit(marker) {
  msgs = [];
  sb.kernel.vfs.writeFile(`${APP}/App.tsx`, `import { Text, View } from 'react-native';\nexport default function App(){ return (<View><Text>${marker}</Text></View>); }\n`);
  // some templates use App.js; write both to be safe
  try { sb.kernel.vfs.writeFile(`${APP}/App.js`, `import { Text, View } from 'react-native';\nexport default function App(){ return (<View><Text>${marker}</Text></View>); }\n`); } catch {}
  await new Promise((r) => setTimeout(r, 4000));
  return msgs.map((m) => (m && m.type) || m);
}

log('--- EDIT #1 ---');
const e1 = await edit('HMR_V1');
log('edit#1 messages:', JSON.stringify(e1));
log('--- EDIT #2 ---');
const e2 = await edit('HMR_V2');
log('edit#2 messages:', JSON.stringify(e2));

clearInterval(drain);
console.log('\n===== VERDICT =====');
console.log('edit#1 update pushed:', e1.includes('update') || e1.includes('update-start'));
console.log('edit#2 update pushed:', e2.includes('update') || e2.includes('update-start'));
server.close();
process.exit(0);
