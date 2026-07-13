#!/usr/bin/env node
/** Boot expo start --web, fetch the bundle, and print how it builds the HMR ws URL. */
import http from 'node:http';
import { Sandbox } from '../packages/core/dist/index.js';
const CORS = 8814, PORT = 8081, APP = '/home/user/my-app';
const out = (s) => process.stdout.write(s);
const server = http.createServer((q, r) => { (async () => { const t = new URL(q.url, 'http://x').searchParams.get('url'); if (!t) { r.statusCode = 400; return r.end('x'); } const u = await fetch(t, { headers: { accept: '*/*', 'user-agent': 'lifo' } }); r.statusCode = u.status; r.end(Buffer.from(await u.arrayBuffer())); })().catch((e) => { r.statusCode = 502; r.end(e.message); }); });
await new Promise((r) => server.listen(CORS, r));
const sb = await Sandbox.create({ files: {}, cwd: '/home/user', persist: false, env: { LIFO_CORS_PROXY: `http://localhost:${CORS}/_cors?url=`, EXPO_NO_TELEMETRY: '1', BROWSER: 'none' } });
await sb.commands.run(`npx create-expo-app@latest ${APP} --template blank --no-install`, { cwd: '/home/user', onStdout: out, onStderr: out, timeout: 300000 });
await sb.commands.run('npm install', { cwd: APP, onStdout: out, onStderr: out, timeout: 600000 });
const rv = JSON.parse(new TextDecoder().decode(sb.kernel.vfs.readFile(`${APP}/node_modules/react/package.json`))).version;
await sb.commands.run(`npm install react-dom@${rv} react-native-web@~0.21.0`, { cwd: APP, onStdout: out, onStderr: out, timeout: 600000 });
sb.shell.execute(`node ${APP}/node_modules/expo/bin/cli start --web ${APP}`, { cwd: APP, env: { ...sb.env, EXPO_OFFLINE: '1' }, onStdout: out, onStderr: out }).catch(() => {});
for (let i = 0; i < 300; i++) { if (sb.kernel.portRegistry.has(PORT)) break; await new Promise((r) => setTimeout(r, 400)); }
const req = (url) => new Promise((res) => { const h = sb.kernel.portRegistry.get(PORT); const v = { statusCode: 200, headers: {}, body: '' }; h({ method: 'GET', url, headers: { host: `localhost:${PORT}` }, body: '' }, v); v._donePromise ? v._donePromise.then(() => res(v)) : res(v); });
const bodyOf = (v) => (v.bodyBytes ? new TextDecoder().decode(v.bodyBytes) : v.body);
const home = bodyOf(await req('/'));
const bu = (home.match(/<script\s+src=["']([^"']+\.bundle[^"']*)["']/i) || [])[1] || '/index.bundle?platform=web&dev=true&hot=true';
console.log('\n\nBUNDLE URL:', bu);
const bundle = bodyOf(await req(bu.replace('hot=false', 'hot=true')));
console.log('bundle bytes:', bundle.length);
// find WebSocket construction sites and their URL expression
const lines = bundle.split('\n');
const hits = [];
lines.forEach((ln, i) => { if (/new WebSocket\(|getHMRUrl|WebSocketHMRClient|\/hot|createHMRClient|hmrServerUrl|getDevServer|serverHost|hmrPort/.test(ln)) hits.push([i, ln]); });
function block(a, b) { console.log(`\n----- L${a}-${b} -----`); for (let i = a - 1; i < b && i < lines.length; i++) console.log(`L${i + 1}| ${lines[i].trim().slice(0, 170)}`); }
console.log('\n===== entry-point / bundle-url construction =====');
block(1703, 1710);   // setup() pendingEntryPoints.push
block(3862, 3872);   // currentScript.src -> bundleUrl
block(4803, 4820);   // getBundleUrl.web.ts
block(4885, 4902);   // registerBundle(requestUrl) caller
block(4983, 4996);   // currentSrc
server.close();
process.exit(0);
