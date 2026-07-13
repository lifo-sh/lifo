#!/usr/bin/env node
/**
 * prune-trace.mjs — measure how small a Lifo box snapshot can get if we keep
 * only the node_modules files actually TOUCHED while running a real Expo web
 * bundle.
 *
 * Idea: a blank Expo app installs a huge node_modules, but `expo start --web`
 * only reads a fraction of it to produce the first web bundle. We trace every
 * VFS access, snapshot AFTER the first bundle (so Metro's warm cache + the
 * built bundle are captured), then compare:
 *    full snapshot (everything)   vs   pruned snapshot (touched files only).
 *
 *   node bench/prune-trace.mjs
 *
 * Requires the core package to be built (pnpm --filter @lifo-sh/core build).
 */
import { performance } from 'node:perf_hooks';
import http from 'node:http';
import zlib from 'node:zlib';
import { Sandbox, exportVfsSnapshot } from '../packages/core/dist/index.js';

const CORS_PORT = 8791;
const PREVIEW_PORT = 8081;
const APP_DIR = '/home/user/my-app';

const log = (...a) => console.log(`[${((performance.now() - T0) / 1000).toFixed(1)}s]`, ...a);
const T0 = performance.now();

// VM code runs in this realm, so a VM async-throw surfaces as a host rejection.
// Log it but keep the measurement alive.
process.on('unhandledRejection', (e) => log('UNHANDLED REJECTION:', e?.message || e));
process.on('uncaughtException', (e) => log('UNCAUGHT:', e?.message || e));

// ── 1. Tiny /_cors?url= proxy (Node fetch has no CORS restriction) ───────────
function startCorsProxy() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      (async () => {
        const u = new URL(req.url, 'http://localhost');
        const target = u.searchParams.get('url');
        if (!target) { res.statusCode = 400; return res.end('missing url'); }
        const chunks = [];
        for await (const c of req) chunks.push(c);
        const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
        const up = await fetch(target, {
          method: req.method,
          headers: {
            accept: req.headers['accept'] || '*/*',
            'user-agent': req.headers['user-agent'] || 'lifo',
            ...(req.headers['content-type'] ? { 'content-type': req.headers['content-type'] } : {}),
          },
          body: hasBody ? Buffer.concat(chunks) : undefined,
        });
        const body = Buffer.from(await up.arrayBuffer());
        res.statusCode = up.status;
        res.setHeader('content-type', up.headers.get('content-type') || 'application/octet-stream');
        res.end(body);
      })().catch((e) => { res.statusCode = 502; res.end('cors err: ' + e.message); });
    });
    server.listen(CORS_PORT, () => resolve(server));
  });
}

// ── 2. Instrument the VFS: record accesses BY KIND ───────────────────────────
// reads   = readFile  (bytes actually needed to execute/transform)
// stats   = stat/lstat/readdir/exists/... (crawler probes — NOT proof of need)
// writes  = writeFile (generated artifacts: metro cache, bundle, .expo)
function instrument(vfs) {
  const reads = new Set(), stats = new Set(), writes = new Set();
  const rec = (set) => (p) => { if (typeof p === 'string') set.add(p); };
  const map = {
    readFile: rec(reads),
    writeFile: rec(writes),
    stat: rec(stats), lstat: rec(stats), readdir: rec(stats),
    exists: rec(stats), readlink: rec(stats), realpath: rec(stats),
  };
  for (const [m, record] of Object.entries(map)) {
    const orig = vfs[m];
    if (typeof orig !== 'function') continue;
    vfs[m] = function (p, ...rest) { record(p); return orig.call(this, p, ...rest); };
  }
  return { reads, stats, writes };
}

// ── 3. Fire a virtual HTTP request into a bound port (no service worker) ──────
function vmRequest(kernel, port, url, { method = 'GET', headers = {}, timeoutMs = 120000 } = {}) {
  const handler = kernel.portRegistry.get(port);
  if (!handler) throw new Error(`no handler on port ${port}`);
  const vReq = { method, url, headers: { host: `localhost:${port}`, ...headers }, body: '' };
  const vRes = { statusCode: 200, headers: {}, body: '' };
  handler(vReq, vRes);
  const finish = () => {
    const text = vRes.bodyBytes ? new TextDecoder().decode(vRes.bodyBytes) : (vRes.body || '');
    return {
      status: vRes.statusCode,
      headers: vRes.headers,
      bytes: vRes.bodyBytes ? vRes.bodyBytes.byteLength : Buffer.byteLength(vRes.body || ''),
      text,
    };
  };
  if (vRes._donePromise) {
    const to = new Promise((_, rej) => setTimeout(() => rej(new Error('vmRequest timeout')), timeoutMs));
    return Promise.race([vRes._donePromise.then(finish), to]);
  }
  return Promise.resolve(finish());
}

async function waitForPort(kernel, port, timeoutMs = 180000) {
  const start = performance.now();
  while (performance.now() - start < timeoutMs) {
    if (kernel.portRegistry.has(port)) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

// ── 4. Snapshot size helpers ─────────────────────────────────────────────────
function gz(buf) { return zlib.gzipSync(buf, { level: 6 }).length; }
const MB = (n) => (n / 1048576).toFixed(1) + ' MB';

// Sum raw + gzip size of a set of VFS files (pruned view) without building a tar.
function measureFiles(vfs, keep) {
  let raw = 0;
  const parts = [];
  for (const p of keep) {
    try {
      const st = vfs.stat(p);
      if (st.type !== 'file') continue;
      const data = vfs.readFile(p);
      raw += data.byteLength;
      parts.push(data);
    } catch { /* pruned probe path that doesn't exist as a file */ }
  }
  const blob = Buffer.concat(parts.map((u) => Buffer.from(u.buffer, u.byteOffset, u.byteLength)));
  return { raw, gz: gz(blob), count: parts.length };
}

// Walk every file in the VFS.
function allFiles(vfs, dir = '/', out = []) {
  let entries;
  try { entries = vfs.readdir(dir); } catch { return out; }
  for (const e of entries) {
    if (dir === '/proc' || dir === '/dev') continue;
    const full = dir === '/' ? `/${e.name}` : `${dir}/${e.name}`;
    let st;
    try { st = vfs.stat(full); } catch { continue; }
    if (st.type === 'directory') allFiles(vfs, full, out);
    else out.push(full);
  }
  return out;
}

async function main() {
  const cors = await startCorsProxy();
  log(`cors proxy on :${CORS_PORT}`);

  const sb = await Sandbox.create({
    files: {},
    cwd: '/home/user',
    persist: false,
    env: {
      LIFO_CORS_PROXY: `http://localhost:${CORS_PORT}/_cors?url=`,
      EXPO_NO_TELEMETRY: '1',
      EXPO_NO_DEPENDENCY_VALIDATION: '1',
      BROWSER: 'none',
    },
  });
  log('sandbox booted');

  const trace = instrument(sb.kernel.vfs);

  const onOut = (s) => process.stdout.write(s);
  const runOpts = (cwd) => ({ cwd, onStdout: onOut, onStderr: onOut, timeout: 900000 });

  log('running create-expo-app (blank template)…');
  // Absolute VM path — a relative name gets resolved against a host path by
  // create-expo-app's find-up, landing the app in the wrong place.
  const r1 = await sb.commands.run(
    `npx create-expo-app@latest ${APP_DIR} --template blank --no-install`,
    runOpts('/home/user'),
  ).catch((e) => ({ exitCode: -1, err: e.message }));
  log('create-expo-app exit', r1.exitCode, r1.err || '');
  try { log('app package.json:', sb.kernel.vfs.readFile(`${APP_DIR}/package.json`).length, 'bytes'); }
  catch (e) { log('!! app not at expected path:', e.message); }

  log('npm install…');
  const r2 = await sb.commands.run('npm install', runOpts(APP_DIR))
    .catch((e) => ({ exitCode: -1, err: e.message }));
  log('npm install exit', r2.exitCode, r2.err || '');

  // The blank template is native-only; `expo start --web` needs the web runtime
  // deps. Install them explicitly (offline expo can't auto-add them).
  log('installing web deps (react-dom, react-native-web)…');
  const r2b = await sb.commands.run('npm install react-dom react-native-web@~0.21.0', runOpts(APP_DIR))
    .catch((e) => ({ exitCode: -1, err: e.message }));
  log('web deps exit', r2b.exitCode, r2b.err || '');

  // Count node_modules footprint BEFORE trace measurement.
  const filesAfterInstall = allFiles(sb.kernel.vfs);
  const nmAll = filesAfterInstall.filter((f) => f.includes('/node_modules/'));
  log(`node_modules files after install: ${nmAll.length}`);

  // Clear the trace so we only capture what the dev-server + BUNDLE touches
  // (install reads lots we don't need at bundle time).
  trace.reads.clear(); trace.stats.clear(); trace.writes.clear();

  log('starting expo web dev server (background)…');
  // Invoke the installed CLI directly (NOT npx — npx leaks the host cwd to the
  // spawned bin) and pass the project root explicitly so cwd is irrelevant.
  const expoCli = `${APP_DIR}/node_modules/@expo/cli/build/bin/cli`;
  // Do NOT await — it's long-running. Poll for the port.
  sb.shell.execute(`node ${expoCli} start --web ${APP_DIR}`, {
    cwd: APP_DIR,
    // EXPO_OFFLINE skips the Expo version endpoint (fatal Bad Gateway otherwise);
    // Metro bundling is fully local so offline is fine.
    env: { ...sb.env, EXPO_OFFLINE: '1' },
    onStdout: onOut,
    onStderr: onOut,
  }).catch((e) => log('expo start ended:', e.message));

  const bound = await waitForPort(sb.kernel, PREVIEW_PORT);
  log(`port ${PREVIEW_PORT} bound: ${bound}`);
  if (!bound) { console.error('DEV SERVER NEVER BOUND — aborting'); await dump(sb, trace); process.exit(2); }

  // GET / first (lets Metro finish its startup crawl / haste-map hashing).
  log('GET /');
  try { const res = await vmRequest(sb.kernel, PREVIEW_PORT, '/'); log(`  → ${res.status}, ${res.bytes} bytes`); }
  catch (e) { log(`  → ERROR ${e.message}`); }

  // Snapshot the STARTUP+CRAWL reads, then clear so trace.reads captures ONLY
  // the reads done to actually build the bundle (module transforms).
  const crawlReads = new Set([...trace.reads].filter(isNM));
  trace.reads.clear();

  log('GET /index.bundle (isolating bundle-time reads)');
  let bundleModulePaths = new Set();
  try {
    const res = await vmRequest(sb.kernel, PREVIEW_PORT, '/index.bundle?platform=web&dev=true&hot=false');
    log(`  → ${res.status}, ${res.bytes} bytes`);
    // Metro dev bundle embeds each module's real path (verboseName). Extract the
    // node_modules source files that actually made it into the bundle graph.
    for (const m of res.text.matchAll(/node_modules\/(?:@[\w.-]+\/)?[\w.-]+(?:\/[\w.@$+-]+)*\.(?:js|jsx|ts|tsx|json|cjs|mjs)/g)) {
      bundleModulePaths.add(`${APP_DIR}/${m[0]}`);
    }
    log(`  bundle references ${bundleModulePaths.size} distinct node_modules source files`);
  } catch (e) { log(`  → ERROR ${e.message}`); }

  await dump(sb, trace, crawlReads, bundleModulePaths);
  cors.close();
  process.exit(0);
}

const isNM = (f) => f.includes('/node_modules/');
const isPkgJson = (f) => f.endsWith('/package.json');

async function dump(sb, trace, crawlReads = new Set(), bundleModulePaths = new Set()) {
  const vfs = sb.kernel.vfs;
  log('measuring…');

  // CAPTURE the live trace FIRST — exportVfsSnapshot/allFiles/measureFiles below
  // all go through the instrumented VFS and would otherwise pollute it to 100%.
  const bundleReads = [...trace.reads].filter(isNM);   // reads to BUILD the bundle
  const traceStats = [...trace.stats];
  const writes = [...trace.writes];
  const pkgJsons = [...traceStats, ...crawlReads, ...trace.reads].filter((f) => isNM(f) && isPkgJson(f));

  const fullTar = await exportVfsSnapshot(vfs);
  const fullGz = gz(Buffer.from(fullTar.buffer, fullTar.byteOffset, fullTar.byteLength));

  const all = allFiles(vfs);
  const nmNow = all.filter(isNM);
  const nonNm = all.filter((f) => !isNM(f));

  // A) bundle-time reads (modules Metro transforms) + resolution package.jsons
  // B) + startup-crawl reads (what Metro reads just to boot the dev server)
  const keepBundle = new Set([...bundleReads, ...pkgJsons]);
  const keepBoot = new Set([...bundleReads, ...crawlReads, ...pkgJsons]);

  // The TRUE critical path: source files that actually made it into the bundle
  // graph + their package.jsons (needed for resolution).
  const graphPkgJsons = [...pkgJsons].filter((p) => {
    // keep pkg.json of any package whose files are in the graph
    const pkgDir = p.slice(0, -'/package.json'.length);
    for (const f of bundleModulePaths) if (f.startsWith(pkgDir + '/')) return true;
    return false;
  });
  const keepGraph = new Set([...bundleModulePaths, ...graphPkgJsons]);

  // Option-2 keep-set: everything Metro actually READ (startup toolchain boot +
  // bundle-time transforms + hashing) + resolution package.jsons. This is the
  // "keep real Metro, delete the rest" candidate.
  const keepMetro = new Set([...bundleReads, ...crawlReads, ...pkgJsons]);

  const nmFull = measureFiles(vfs, new Set(nmNow));
  const nmGraph = measureFiles(vfs, keepGraph);
  const nmBundleReads = measureFiles(vfs, new Set(bundleReads));
  const nmCrawlReads = measureFiles(vfs, crawlReads);
  const nmKeepMetro = measureFiles(vfs, keepMetro);
  const nonNmNoCache = measureFiles(vfs, new Set(nonNm.filter((f) => !f.includes('/.expo/') && !f.includes('/.cache/'))));

  console.log('\n================= PRUNE TRACE RESULTS =================');
  console.log('Full VFS files:               ', all.length, `(nm ${nmNow.length}, non-nm ${nonNm.length})`);
  console.log('nm READ at STARTUP (boot):    ', nmCrawlReads.count, `(${((nmCrawlReads.count / nmNow.length) * 100).toFixed(1)}%)`);
  console.log('nm READ during BUNDLE:        ', nmBundleReads.count, `(${((nmBundleReads.count / nmNow.length) * 100).toFixed(1)}%)`);
  console.log('nm READ total (keep-Metro):   ', nmKeepMetro.count, `(${((nmKeepMetro.count / nmNow.length) * 100).toFixed(1)}%)`);
  console.log('BUNDLE GRAPH source files:    ', bundleModulePaths.size, `+ ${graphPkgJsons.length} pkg.json`);
  console.log('------------------------------------------------------');
  console.log('FULL   node_modules gz:       ', MB(nmFull.gz), `(full snapshot tar.gz ${MB(fullGz)})`);
  console.log('KEEP-METRO node_modules gz:   ', MB(nmKeepMetro.gz), `(${nmKeepMetro.count} files — toolchain + graph)`);
  console.log('GRAPH-ONLY node_modules gz:   ', MB(nmGraph.gz), `(${nmGraph.count} files — app runtime only)`);
  console.log('app source (no cache) gz:     ', MB(nonNmNoCache.gz));
  console.log('------------------------------------------------------');
  console.log('=> OPTION-2 snapshot (keep Metro): ', MB(nmKeepMetro.gz + nonNmNoCache.gz), ' <-- toolchain+graph+app');
  console.log('=> Prebuilt-bundle snapshot:       ', MB(nmGraph.gz + nonNmNoCache.gz), ' <-- graph+app only');
  console.log('   full snapshot:                  ', MB(fullGz));
  console.log('======================================================\n');
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
