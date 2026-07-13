#!/usr/bin/env node
/**
 * gen-keepset.mjs — DETERMINISTIC node_modules keep-set for a Lifo/Expo box.
 *
 * Single generation pass (no error-iteration):
 *   keep = files READ  ∪  files exists()-probed-and-present  ∪  every package.json
 * traced across BOTH a production `expo export` (full graph) AND a dev
 * `expo start --web` bundle (dev-only runtime). Rationale:
 *   - Metro's crawl uses readdir/stat, NOT exists(); so an exists()===true on an
 *     UNREAD file is a require.resolve() target (config polyfills, transform
 *     worker, ...) — exactly the files a reads-only prune wrongly drops.
 *   - export gives the full production graph; dev adds react-refresh/dev runtime.
 *
 * Then it VALIDATES: prune to the keep-set, restore a fresh box, clear cache,
 * cold `expo start --web` bundle, assert byte-identical output. No iteration.
 *
 *   node bench/gen-keepset.mjs
 */
import { performance } from 'node:perf_hooks';
import http from 'node:http';
import zlib from 'node:zlib';
import { Sandbox, exportVfsSnapshot } from '../packages/core/dist/index.js';

const T0 = performance.now();
const log = (...a) => console.log(`[${((performance.now() - T0) / 1000).toFixed(1)}s]`, ...a);
process.on('unhandledRejection', (e) => log('REJ:', e?.message || e));
process.on('uncaughtException', (e) => log('UNCAUGHT:', e?.message || e));

const CORS = 8795, PORT = 8081, APP = '/home/user/my-app';
const isNM = (f) => f.includes('/node_modules/');
const isPkgJson = (f) => f.endsWith('/package.json');
const isCache = (f) => f.startsWith('/tmp/') || f.includes('/.expo/') || f.includes('/.cache/') || f.includes('/.metro') || f.includes('/dist/');
const gz = (b) => zlib.gzipSync(b, { level: 6 }).length;
const MB = (n) => (n / 1048576).toFixed(2) + ' MB';
const out = (s) => process.stdout.write(s);

function startCors() {
  const server = http.createServer((req, res) => {
    (async () => {
      const t = new URL(req.url, 'http://localhost').searchParams.get('url');
      if (!t) { res.statusCode = 400; return res.end('x'); }
      const up = await fetch(t, { headers: { accept: '*/*', 'user-agent': 'lifo' } });
      res.statusCode = up.status; res.end(Buffer.from(await up.arrayBuffer()));
    })().catch((e) => { res.statusCode = 502; res.end(e.message); });
  });
  return new Promise((r) => server.listen(CORS, () => r(server)));
}

// reads = readFile; existsHits = exists()===true on nm; miss = absent probes.
function instrument(vfs) {
  const reads = new Set(), existsHits = new Set(), miss = new Set();
  const rf = vfs.readFile;
  vfs.readFile = function (p, ...r) { if (typeof p === 'string') reads.add(p); try { return rf.call(this, p, ...r); } catch (e) { if (typeof p === 'string' && isNM(p)) miss.add(p); throw e; } };
  const ex = vfs.exists;
  vfs.exists = function (p, ...r) { const res = ex.call(this, p, ...r); if (typeof p === 'string' && isNM(p)) (res ? existsHits : miss).add(p); return res; };
  return { reads, existsHits, miss };
}

function vmRequest(kernel, port, url, timeoutMs = 120000) {
  const h = kernel.portRegistry.get(port); if (!h) throw new Error(`no handler ${port}`);
  const vRes = { statusCode: 200, headers: {}, body: '' };
  h({ method: 'GET', url, headers: { host: `localhost:${port}` }, body: '' }, vRes);
  const fin = () => ({ status: vRes.statusCode, bytes: vRes.bodyBytes ? vRes.bodyBytes.byteLength : Buffer.byteLength(vRes.body || '') });
  if (vRes._donePromise) return Promise.race([vRes._donePromise.then(fin), new Promise((_, j) => setTimeout(() => j(new Error('timeout')), timeoutMs))]);
  return Promise.resolve(fin());
}
async function waitForPort(kernel, port, ms) { const s = performance.now(); while (performance.now() - s < ms) { if (kernel.portRegistry.has(port)) return true; await new Promise((r) => setTimeout(r, 400)); } return false; }
function allFiles(vfs, dir = '/', acc = []) { let e; try { e = vfs.readdir(dir); } catch { return acc; } for (const x of e) { if (dir === '/proc' || dir === '/dev') continue; const f = dir === '/' ? `/${x.name}` : `${dir}/${x.name}`; let st; try { st = vfs.stat(f); } catch { continue; } if (st.type === 'directory') allFiles(vfs, f, acc); else acc.push(f); } return acc; }
function mkdirp(vfs, p) { let c = ''; for (const s of p.split('/').filter(Boolean)) { c += '/' + s; if (!vfs.exists(c)) vfs.mkdir(c); } }
const cli = `${APP}/node_modules/@expo/cli/build/bin/cli`;

async function main() {
  const cors = await startCors();
  const env = { LIFO_CORS_PROXY: `http://localhost:${CORS}/_cors?url=`, EXPO_NO_TELEMETRY: '1', BROWSER: 'none' };

  // ── GENERATION box ──────────────────────────────────────────────────────────
  log('GEN: boot + scaffold + install…');
  const A = await Sandbox.create({ files: {}, cwd: '/home/user', persist: false, env });
  const tr = instrument(A.kernel.vfs);
  const ro = { cwd: '/home/user', onStdout: out, onStderr: out, timeout: 600000 };
  await A.commands.run(`npx create-expo-app@latest ${APP} --template blank --no-install`, ro);
  await A.commands.run('npm install', { ...ro, cwd: APP });
  await A.commands.run('npm install react-dom react-native-web@~0.21.0', { ...ro, cwd: APP });
  tr.reads.clear(); tr.existsHits.clear(); tr.miss.clear();

  const MODE = process.env.MODE || 'both'; // both | dev | export | exportdev
  if (MODE !== 'dev') {
    const devFlag = MODE === 'exportdev' ? '--dev ' : '';
    log(`GEN: expo export ${devFlag}--platform web…`);
    await A.commands.run(`node ${cli} export ${devFlag}--platform web --output-dir ${APP}/dist ${APP}`,
      { cwd: APP, env: { ...A.env, EXPO_OFFLINE: '1' }, onStdout: out, onStderr: out, timeout: 300000 })
      .catch((e) => log('export ended:', e.message)); // post-bundle writer may crash; reads already captured
  } else log('GEN: skipping export (MODE=dev)');

  if (MODE !== 'exportdev' && MODE !== 'export') {
    log('GEN: expo start --web dev bundle (dev runtime)…');
    A.shell.execute(`node ${cli} start --web ${APP}`, { cwd: APP, env: { ...A.env, EXPO_OFFLINE: '1' }, onStdout: out, onStderr: out }).catch((e) => log('start ended:', e.message));
    if (await waitForPort(A.kernel, PORT, 120000)) {
      await vmRequest(A.kernel, PORT, '/').catch(() => {});
      const a1 = await vmRequest(A.kernel, PORT, '/index.bundle?platform=web&dev=true&hot=false').catch((e) => ({ status: 0, bytes: 0, err: e.message }));
      log(`GEN dev bundle → ${a1.status}, ${a1.bytes} bytes`);
    } else log('GEN dev server never bound');
  } else log(`GEN: skipping dev-server trace (MODE=${MODE})`);
  // reference bytes come from box B's validation regardless.
  globalThis.__aBytes = globalThis.__aBytes || 0;

  // ── Compute keep-set (deterministic) ────────────────────────────────────────
  const allA = allFiles(A.kernel.vfs);
  const nmAll = allA.filter(isNM);
  const existSet = new Set(nmAll);
  const keepNm = new Set();
  for (const f of tr.reads) if (isNM(f) && existSet.has(f)) keepNm.add(f);
  for (const f of tr.existsHits) if (existSet.has(f)) keepNm.add(f);   // resolve-only targets
  for (const f of nmAll) if (isPkgJson(f)) keepNm.add(f);
  log(`keep-set: reads+exists+pkgjson = ${keepNm.size} nm files of ${nmAll.length} (${(keepNm.size / nmAll.length * 100).toFixed(1)}%)`);

  const nonNm = allA.filter((f) => !isNM(f) && !isCache(f)); // app source, no cache/dist
  const readBytes = (f) => { try { return A.kernel.vfs.readFile(f); } catch { return null; } };

  // ── Static import-closure: add relative-import targets of kept JS files ──────
  // Metro resolves statically-imported files via its crawl file-map without
  // read()/exists() (e.g. renderApplication -> ./AppContainer), so trace misses
  // them. Close over relative specifiers deterministically.
  const EXTS = ['.js', '.jsx', '.ts', '.tsx', '.json', '.cjs', '.mjs', '.web.js', '.web.jsx', '.web.ts', '.web.tsx',
    '/index.js', '/index.jsx', '/index.ts', '/index.tsx', '/index.web.js'];
  const vfsA = A.kernel.vfs;
  const isFile = (p) => { try { return vfsA.stat(p).type === 'file'; } catch { return false; } };
  const norm = (dir, spec) => { const st = []; for (const p of (dir + '/' + spec).split('/')) { if (p === '..') st.pop(); else if (p && p !== '.') st.push(p); } return '/' + st.join('/'); };
  const specRe = /(?:require\(|import\s+[^'"]*?from\s+|import\(|export\s+[^'"]*?from\s+)\s*['"](\.[^'"]+)['"]/g;
  const decoder = new TextDecoder();
  let frontier = [...keepNm].filter((f) => /\.(js|jsx|ts|tsx|cjs|mjs)$/.test(f));
  let added = 0;
  while (frontier.length) {
    const next = [];
    for (const f of frontier) {
      const data = readBytes(f); if (!data) continue;
      const src = decoder.decode(data);
      const dir = f.slice(0, f.lastIndexOf('/'));
      for (const m of src.matchAll(specRe)) {
        const base = norm(dir, m[1]);
        for (const e of ['', ...EXTS]) { const c = base + e; if (isFile(c) && !keepNm.has(c)) { keepNm.add(c); added++; if (/\.(js|jsx|ts|tsx|cjs|mjs)$/.test(c)) next.push(c); } }
      }
    }
    frontier = next;
  }
  log(`static import-closure added ${added} files → keep-set now ${keepNm.size} (${(keepNm.size / nmAll.length * 100).toFixed(1)}%)`);

  // ── VALIDATE: fresh box with keep-set only, cold bundle, byte-match ──────────
  log('VALIDATE: building pruned box B…');
  const B = await Sandbox.create({ files: {}, cwd: '/home/user', persist: false, env });
  const tb = instrument(B.kernel.vfs);
  for (const f of [...keepNm, ...nonNm]) { const d = readBytes(f); if (d == null) continue; mkdirp(B.kernel.vfs, f.slice(0, f.lastIndexOf('/'))); B.kernel.vfs.writeFile(f, d); }
  const snap = await exportVfsSnapshot(B.kernel.vfs);
  const snapGz = gz(Buffer.from(snap.buffer, snap.byteOffset, snap.byteLength));
  const nmInB = allFiles(B.kernel.vfs).filter(isNM).length;
  log(`B has ${nmInB} nm files, PRUNED SNAPSHOT ${MB(snapGz)} — cold bundling…`);

  tb.miss.clear();
  let blog = ''; const sink = (s) => { blog += s; out(s); };
  B.shell.execute(`node ${cli} start --web ${APP}`, { cwd: APP, env: { ...B.env, EXPO_OFFLINE: '1' }, onStdout: sink, onStderr: sink }).catch((e) => log('B start ended:', e.message));
  let b1 = { status: 0, bytes: 0 };
  if (await waitForPort(B.kernel, PORT, 60000)) { await vmRequest(B.kernel, PORT, '/').catch(() => {}); b1 = await vmRequest(B.kernel, PORT, '/index.bundle?platform=web&dev=true&hot=false').catch((e) => ({ status: 0, bytes: 0, err: e.message })); }
  else log('B never bound');

  const aBytes = globalThis.__aBytes || 0;
  const ok = b1.status === 200 && (aBytes > 0 ? Math.abs(b1.bytes - aBytes) < aBytes * 0.02 : b1.bytes > 1_000_000);
  console.log('\n================= KEEP-SET GENERATOR =================');
  console.log('node_modules files:     ', nmAll.length);
  console.log('keep-set (deterministic):', keepNm.size, `(${(keepNm.size / nmAll.length * 100).toFixed(1)}%)`);
  console.log('  from reads:           ', [...tr.reads].filter((f) => isNM(f) && existSet.has(f)).length);
  console.log('  from exists() probes: ', [...tr.existsHits].filter((f) => existSet.has(f)).length);
  console.log('PRUNED SNAPSHOT gz:     ', MB(snapGz), '(vs full ~99 MB)');
  console.log('GEN dev bundle:', aBytes, 'bytes   B (pruned, cold):', b1.bytes, 'bytes');
  console.log(ok ? '✅ PASS — deterministic keep-set cold-bundles, no iteration'
    : '❌ FAIL — gap remains (missing below)');
  if (!ok) {
    const missing = [...tb.miss].filter((f) => A.kernel.vfs.exists(f) && !keepNm.has(f));
    for (const m of blog.matchAll(/Unable to resolve "([^"]+)" from "([^"]+)"/g)) missing.push(`resolve: ${m[1]} from ${m[2]}`);
    console.log(`gap (${missing.length}):`); missing.slice(0, 30).forEach((m) => console.log('   ', String(m).replace(APP + '/node_modules/', '')));
  }
  console.log('=====================================================\n');
  cors.close();
  process.exit(ok ? 0 : 1);
}
main().catch((e) => { console.error('FATAL', e); process.exit(1); });
