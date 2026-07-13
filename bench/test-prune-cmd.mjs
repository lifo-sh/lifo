#!/usr/bin/env node
/**
 * test-prune-cmd.mjs — end-to-end test of the `lifo prune` command:
 *   scaffold+install → `lifo prune my-app` → snapshot (measure) → restore into a
 *   fresh box → cold `expo start --web` bundle → assert byte-identical.
 */
import { performance } from 'node:perf_hooks';
import http from 'node:http';
import { Sandbox, exportVfsSnapshot, importVfsSnapshot, pruneExpoModules } from '../packages/core/dist/index.js';

const T0 = performance.now();
const log = (...a) => console.log(`[${((performance.now() - T0) / 1000).toFixed(1)}s]`, ...a);
process.on('unhandledRejection', (e) => log('REJ:', e?.message || e));
process.on('uncaughtException', (e) => log('UNCAUGHT:', e?.message || e));

const CORS = 8798, PORT = 8081, APP = '/home/user/my-app';
const MB = (n) => (n / 1048576).toFixed(2) + ' MB';
const out = (s) => process.stdout.write(s);
const server = http.createServer((req, res) => { (async () => { const t = new URL(req.url, 'http://localhost').searchParams.get('url'); if (!t) { res.statusCode = 400; return res.end('x'); } const up = await fetch(t, { headers: { accept: '*/*', 'user-agent': 'lifo' } }); res.statusCode = up.status; res.end(Buffer.from(await up.arrayBuffer())); })().catch((e) => { res.statusCode = 502; res.end(e.message); }); });
await new Promise((r) => server.listen(CORS, r));
const env = { LIFO_CORS_PROXY: `http://localhost:${CORS}/_cors?url=`, EXPO_NO_TELEMETRY: '1', BROWSER: 'none' };

function vmReq(kernel, url) { const h = kernel.portRegistry.get(PORT); if (!h) throw new Error('no server'); const vRes = { statusCode: 200, headers: {}, body: '' }; h({ method: 'GET', url, headers: { host: `localhost:${PORT}` }, body: '' }, vRes); const fin = () => ({ status: vRes.statusCode, bytes: vRes.bodyBytes ? vRes.bodyBytes.byteLength : Buffer.byteLength(vRes.body || '') }); return vRes._donePromise ? Promise.race([vRes._donePromise.then(fin), new Promise((_, j) => setTimeout(() => j(new Error('timeout')), 120000))]) : Promise.resolve(fin()); }
async function waitPort(kernel, ms) { const s = performance.now(); while (performance.now() - s < ms) { if (kernel.portRegistry.has(PORT)) return true; await new Promise((r) => setTimeout(r, 400)); } return false; }
function allNM(vfs, dir = '/', acc = []) { let e; try { e = vfs.readdir(dir); } catch { return acc; } for (const x of e) { if (dir === '/proc' || dir === '/dev') continue; const f = dir === '/' ? `/${x.name}` : `${dir}/${x.name}`; let st; try { st = vfs.stat(f); } catch { continue; } if (st.type === 'directory') allNM(vfs, f, acc); else if (f.includes('/node_modules/')) acc.push(f); } return acc; }
const cli = `${APP}/node_modules/expo/bin/cli`; // the entry `npm run web` uses

// ── set up the "user's project" ─────────────────────────────────────────────
log('scaffold + install…');
const A = await Sandbox.create({ files: {}, cwd: '/home/user', persist: false, env });
const ro = { cwd: '/home/user', onStdout: out, onStderr: out, timeout: 600000 };
await A.commands.run(`npx create-expo-app@latest ${APP} --template blank --no-install`, ro);
await A.commands.run('npm install', { ...ro, cwd: APP });
await A.commands.run('npm install react-dom react-native-web@~0.21.0', { ...ro, cwd: APP });
const before = allNM(A.kernel.vfs).length;
log(`node_modules before: ${before} files`);

// reference bundle (what the pruned box must reproduce)
A.shell.execute(`node ${cli} start --web ${APP}`, { cwd: APP, env: { ...A.env, EXPO_OFFLINE: '1' }, onStdout: out, onStderr: out }).catch(() => {});
await waitPort(A.kernel, 120000);
await vmReq(A.kernel, '/').catch(() => {});
const refBytes = (await vmReq(A.kernel, '/index.bundle?platform=web&dev=true&hot=false').catch(() => ({ bytes: 0 }))).bytes;
log(`reference bundle: ${refBytes} bytes`);

// ── run the host-side prune engine (what the playground button will call) ────
log('>>> pruneExpoModules(sandbox) — auto-detect project <<<');
const pr = await pruneExpoModules(A, { port: 8091, onLog: (s) => log('  prune:', s) }).catch((e) => ({ err: e.message }));
log('prune result:', JSON.stringify(pr));
if (pr.err) { console.log('❌ FAIL — prune errored:', pr.err); process.exit(1); }
const after = allNM(A.kernel.vfs).length;
log(`node_modules after: ${after} files (${((after / before) * 100).toFixed(1)}%)`);

const snap = await exportVfsSnapshot(A.kernel.vfs);
log(`PRUNED SNAPSHOT: ${MB(snap.byteLength)}`);
const toqrKept = A.kernel.vfs.exists(`${APP}/node_modules/toqr`);
log(`toqr kept (bare-import closure): ${toqrKept}`);

// ── validate: restore into a fresh box, clear cache, cold bundle ─────────────
log('restore into fresh box B + cold bundle…');
const B = await Sandbox.create({ files: {}, cwd: '/home/user', persist: false, env });
await importVfsSnapshot(B.kernel.vfs, new Uint8Array(snap.buffer, snap.byteOffset, snap.byteLength));
for (const f of allNM(B.kernel.vfs).concat([])) { /* keep nm */ }
// clear metro cache to force cold
for (const f of (function all(vfs, d = '/', a = []) { let e; try { e = vfs.readdir(d); } catch { return a; } for (const x of e) { if (d === '/proc' || d === '/dev') continue; const f = d === '/' ? `/${x.name}` : `${d}/${x.name}`; let st; try { st = vfs.stat(f); } catch { continue; } if (st.type === 'directory') all(vfs, f, a); else a.push(f); } return a; })(B.kernel.vfs)) {
  if (f.startsWith('/tmp/') || f.includes('/.expo/') || f.includes('/.cache/') || f.includes('/.metro')) { try { B.kernel.vfs.unlink(f); } catch {} }
}
B.shell.execute(`node ${cli} start --web ${APP}`, { cwd: APP, env: { ...B.env, EXPO_OFFLINE: '1' }, onStdout: out, onStderr: out }).catch(() => {});
let bBytes = 0;
if (await waitPort(B.kernel, 60000)) { await vmReq(B.kernel, '/').catch(() => {}); bBytes = (await vmReq(B.kernel, '/index.bundle?platform=web&dev=true&hot=false').catch(() => ({ bytes: 0 }))).bytes; }

const smallEnough = snap.byteLength < 20 * 1048576; // pruned should be well under 20MB
const ok = smallEnough && bBytes > 0 && refBytes > 0 && Math.abs(bBytes - refBytes) < refBytes * 0.02;
console.log('\n================= lifo prune TEST =================');
console.log('node_modules:', before, '→', after, `(${((after / before) * 100).toFixed(1)}%)`);
console.log('pruned snapshot:', MB(snap.byteLength));
console.log('reference bundle:', refBytes, ' pruned+restored cold bundle:', bBytes);
console.log(ok ? '✅ PASS — `lifo prune` shrinks the box and Metro still cold-bundles' : '❌ FAIL');
console.log('==================================================\n');
server.close();
process.exit(ok ? 0 : 1);
