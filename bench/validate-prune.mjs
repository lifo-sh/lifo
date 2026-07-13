#!/usr/bin/env node
/**
 * validate-prune.mjs — Option 2 proof: keep REAL Metro, converge on the MINIMAL
 * node_modules subset that still cold-bundles the web app.
 *
 *   Box A: scaffold + install + expo start --web + first bundle (trace reads).
 *   keep := files Metro READ (file-granular) + every package.json.
 *   Loop: build fresh Box B with only `keep` (NO cache → forced cold bundle);
 *         if bundle 200 & bytes match → done; else add the files Metro tried to
 *         resolve but couldn't (ENOENT on existing-in-A paths) and retry.
 *
 *   node bench/validate-prune.mjs
 */
import { performance } from 'node:perf_hooks';
import http from 'node:http';
import zlib from 'node:zlib';
import { Sandbox, exportVfsSnapshot } from '../packages/core/dist/index.js';

const T0 = performance.now();
const log = (...a) => console.log(`[${((performance.now() - T0) / 1000).toFixed(1)}s]`, ...a);
process.on('unhandledRejection', (e) => log('REJ:', e?.message || e));
process.on('uncaughtException', (e) => log('UNCAUGHT:', e?.message || e));

const CORS_PORT = 8793, PORT = 8081, APP = '/home/user/my-app';
const isNM = (f) => f.includes('/node_modules/');
const isPkgJson = (f) => f.endsWith('/package.json');
const isCache = (f) => f.startsWith('/tmp/') || f.includes('/.expo/') || f.includes('/.cache/') || f.includes('/.metro');
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
  return new Promise((r) => server.listen(CORS_PORT, () => r(server)));
}

// reads = readFile paths; miss = nm paths that were probed but ABSENT
// (ENOENT throw on read/stat, OR exists()===false — how require.resolve probes).
function instrument(vfs) {
  const reads = new Set(), miss = new Set();
  const wrap = (m, rec) => {
    const orig = vfs[m]; if (typeof orig !== 'function') return;
    vfs[m] = function (p, ...rest) {
      if (rec && typeof p === 'string') reads.add(p);
      try { return orig.call(this, p, ...rest); }
      catch (e) { if (typeof p === 'string' && isNM(p)) miss.add(p); throw e; }
    };
  };
  wrap('readFile', true);
  for (const m of ['stat', 'lstat', 'readlink', 'realpath']) wrap(m, false);
  const origExists = vfs.exists;
  if (typeof origExists === 'function') {
    vfs.exists = function (p, ...rest) {
      const r = origExists.call(this, p, ...rest);
      if (!r && typeof p === 'string' && isNM(p)) miss.add(p);
      return r;
    };
  }
  return { reads, miss };
}

function vmRequest(kernel, port, url, timeoutMs = 120000) {
  const handler = kernel.portRegistry.get(port);
  if (!handler) throw new Error(`no handler on ${port}`);
  const vRes = { statusCode: 200, headers: {}, body: '' };
  handler({ method: 'GET', url, headers: { host: `localhost:${port}` }, body: '' }, vRes);
  const finish = () => ({
    status: vRes.statusCode,
    bytes: vRes.bodyBytes ? vRes.bodyBytes.byteLength : Buffer.byteLength(vRes.body || ''),
    text: vRes.bodyBytes ? new TextDecoder().decode(vRes.bodyBytes) : (vRes.body || ''),
  });
  if (vRes._donePromise) {
    const to = new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), timeoutMs));
    return Promise.race([vRes._donePromise.then(finish), to]);
  }
  return Promise.resolve(finish());
}

async function waitForPort(kernel, port, ms = 120000) {
  const s = performance.now();
  while (performance.now() - s < ms) { if (kernel.portRegistry.has(port)) return true; await new Promise((r) => setTimeout(r, 400)); }
  return false;
}

function allFiles(vfs, dir = '/', acc = []) {
  let e; try { e = vfs.readdir(dir); } catch { return acc; }
  for (const x of e) {
    if (dir === '/proc' || dir === '/dev') continue;
    const full = dir === '/' ? `/${x.name}` : `${dir}/${x.name}`;
    let st; try { st = vfs.stat(full); } catch { continue; }
    if (st.type === 'directory') allFiles(vfs, full, acc); else acc.push(full);
  }
  return acc;
}
function mkdirp(vfs, path) { let c = ''; for (const p of path.split('/').filter(Boolean)) { c += '/' + p; if (!vfs.exists(c)) vfs.mkdir(c); } }

async function startExpo(sb, sink = out) {
  const cli = `${APP}/node_modules/@expo/cli/build/bin/cli`;
  sb.shell.execute(`node ${cli} start --web ${APP}`, { cwd: APP, env: { ...sb.env, EXPO_OFFLINE: '1' }, onStdout: sink, onStderr: sink })
    .catch((e) => log('expo ended:', e.message));
}
async function coldBundle(sb, label) {
  await vmRequest(sb.kernel, PORT, '/').catch(() => {});
  const r = await vmRequest(sb.kernel, PORT, '/index.bundle?platform=web&dev=true&hot=false').catch((e) => ({ status: 0, bytes: 0, text: '', err: e.message }));
  log(`  ${label} → ${r.status}, ${r.bytes} bytes ${r.err || ''}`);
  return r;
}

const EXTS = ['', '.js', '.jsx', '.ts', '.tsx', '.json', '.cjs', '.mjs', '/index.js', '/index.ts', '.web.js', '.native.js'];
// Given a Metro "Unable to resolve X from Y" pair, find the real file in A.
function resolveTarget(vfs, fromFileAbs, spec) {
  const dir = fromFileAbs.slice(0, fromFileAbs.lastIndexOf('/'));
  const bases = [];
  if (spec.startsWith('.')) {
    // relative
    const parts = (dir + '/' + spec).split('/'); const stack = [];
    for (const p of parts) { if (p === '..') stack.pop(); else if (p !== '.' && p !== '') stack.push(p); }
    bases.push('/' + stack.join('/'));
  } else {
    // bare package import — resolve under the app's node_modules
    bases.push(`${APP}/node_modules/${spec}`);
  }
  for (const b of bases) for (const e of EXTS) { const cand = b + e; if (vfs.exists(cand)) { try { if (vfs.stat(cand).type === 'file') return cand; } catch {} } }
  return null;
}

async function main() {
  const cors = await startCors();
  const env = { LIFO_CORS_PROXY: `http://localhost:${CORS_PORT}/_cors?url=`, EXPO_NO_TELEMETRY: '1', BROWSER: 'none' };

  // ── BOX A: cold flow, keep it alive as the file source ──────────────────────
  log('BOX A: booting…');
  const A = await Sandbox.create({ files: {}, cwd: '/home/user', persist: false, env });
  const trace = instrument(A.kernel.vfs);
  const ro = { cwd: '/home/user', onStdout: out, onStderr: out, timeout: 600000 };
  await A.commands.run(`npx create-expo-app@latest ${APP} --template blank --no-install`, ro);
  await A.commands.run('npm install', { ...ro, cwd: APP });
  await A.commands.run('npm install react-dom react-native-web@~0.21.0', { ...ro, cwd: APP });
  trace.reads.clear();
  await startExpo(A);
  if (!(await waitForPort(A.kernel, PORT))) { log('A never bound'); process.exit(2); }
  const a1 = await coldBundle(A, 'A bundle');

  const allA = allFiles(A.kernel.vfs);
  const nmAll = allA.filter(isNM);
  const nonNm = allA.filter((f) => !isNM(f) && !isCache(f)); // app source, NO cache
  const readBytes = (f) => { try { return A.kernel.vfs.readFile(f); } catch { return null; } };

  // Initial keep: nm files Metro READ (file-granular) + every package.json.
  const keep = new Set([...[...trace.reads].filter(isNM), ...nmAll.filter(isPkgJson)]);
  log(`initial keep: ${keep.size} nm files (of ${nmAll.length})`);

  // ── Converge: build B from keep, cold-bundle, add unresolved files, retry ───
  let iter = 0, ok = false, b1 = { status: 0, bytes: 0 }, snapGz = 0;
  while (iter++ < 20 && !ok) {
    const B = await Sandbox.create({ files: {}, cwd: '/home/user', persist: false, env });
    const tb = instrument(B.kernel.vfs);
    for (const f of [...keep, ...nonNm]) { const data = readBytes(f); if (data == null) continue; mkdirp(B.kernel.vfs, f.slice(0, f.lastIndexOf('/'))); B.kernel.vfs.writeFile(f, data); }
    const nmInB = allFiles(B.kernel.vfs).filter(isNM).length;
    const snap = await exportVfsSnapshot(B.kernel.vfs);
    snapGz = gz(Buffer.from(snap.buffer, snap.byteOffset, snap.byteLength));
    log(`iter ${iter}: B has ${nmInB} nm files, snapshot ${MB(snapGz)} — cold bundling…`);
    tb.miss.clear();
    let blog = '';
    const sink = (s) => { blog += s; };
    await startExpo(B, sink);
    // Metro binds in ~1s when config loads; if not bound in 30s it crashed.
    if (await waitForPort(B.kernel, PORT, 30000)) b1 = await coldBundle(B, `iter ${iter}`);
    else { log(`iter ${iter}: B never bound (config crash)`); b1 = { status: 0, bytes: 0 }; }

    ok = b1.status === 200 && Math.abs(b1.bytes - a1.bytes) < a1.bytes * 0.02;
    if (!ok) {
      const errText = blog + (b1.text || '');
      const add = new Set();
      // (1) config-time probes: exists()===false / ENOENT on files present in A.
      for (const f of tb.miss) if (A.kernel.vfs.exists(f) && !keep.has(f)) add.add(f);
      // (2) bundle-time "Unable to resolve X from Y" (Metro file-map resolution).
      for (const m of errText.matchAll(/Unable to resolve "([^"]+)" from "([^"]+)"/g)) {
        const fromAbs = m[2].startsWith('/') ? m[2] : `${APP}/${m[2]}`;
        const t = resolveTarget(A.kernel.vfs, fromAbs, m[1]);
        if (t && !keep.has(t)) add.add(t);
      }
      log(`iter ${iter}: FAIL — adding ${add.size} files`);
      [...add].slice(0, 20).forEach((f) => log('     + ' + f.replace(APP + '/node_modules/', '')));
      if (add.size === 0) { log('  no addable files — different failure, stopping'); B.destroy?.(); break; }
      for (const f of add) keep.add(f);
    }
    B.destroy?.();
  }

  console.log('\n================= VALIDATION VERDICT =================');
  console.log('A cold bundle:', a1.status, a1.bytes, 'bytes');
  console.log('B cold bundle:', b1.status, b1.bytes, 'bytes  (pruned + fresh box, cache cleared)');
  console.log('iterations to converge:', iter);
  console.log('final kept nm files:', keep.size, 'of', nmAll.length, `(${((keep.size / nmAll.length) * 100).toFixed(1)}%)`);
  console.log('PRUNED SNAPSHOT gz:', MB(snapGz), ' (vs full ~99 MB)');
  console.log(ok ? '✅ PASS — real Metro cold-bundles from the pruned subset' : '❌ FAIL — see missing files above');
  console.log('======================================================\n');
  cors.close();
  process.exit(ok ? 0 : 1);
}
main().catch((e) => { console.error('FATAL', e); process.exit(1); });
