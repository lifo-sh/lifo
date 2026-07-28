/**
 * pruneExpoModules -- shrink an Expo project's node_modules to only what Metro
 * reads, so a box snapshot is tiny (a blank Expo web app: ~99MB -> ~4-5MB).
 * Run it right before snapshotting; real Metro still (cold-)bundles from the
 * pruned tree.
 *
 * Deterministic, single pass. Host-side (needs kernel access) because it must
 * trace the dev server FROM BOOT — the toolchain (Metro/Babel/@expo-cli) is read
 * at startup, and the app graph while bundling. It:
 *   1. Instruments the VFS (readFile + exists()).
 *   2. Cold-starts a scratch `expo start --web -c` and bundles once.
 *   3. keep = READ files  ∪  exists()-probed-present files (require.resolve
 *      targets — Metro's crawl uses readdir/stat, not exists())  ∪  every
 *      package.json  ∪  static relative-import closure of kept JS (catches
 *      statically-imported-but-unread files like react-native-web/AppContainer).
 *   4. Deletes every other node_modules file. The scratch bundle also leaves a
 *      warm Metro cache consistent with the kept files, so restore is instant.
 */

import type { Sandbox } from './Sandbox.js';
import type { Kernel } from '../kernel/index.js';
import { resolve, join, dirname } from '../utils/path.js';
import { dispatchRequest, LIFO_HEADER } from '../kernel/network/dispatch.js';

export interface PruneOptions {
  /** Project dir (default: sandbox cwd). */
  projectDir?: string;
  /** Scratch port for the trace server (default 8091). */
  port?: number;
  /** Progress callback. */
  onLog?: (msg: string) => void;
}

export interface PruneResult {
  before: number;
  after: number;
  deleted: number;
  freedBytes: number;
}

const isNM = (f: string) => f.includes('/node_modules/');
const isPkgJson = (f: string) => f.endsWith('/package.json');
const JS_RE = /\.(js|jsx|ts|tsx|cjs|mjs)$/;
const EXTS = ['', '.js', '.jsx', '.ts', '.tsx', '.json', '.cjs', '.mjs',
  '.web.js', '.web.jsx', '.web.ts', '.web.tsx',
  '/index.js', '/index.jsx', '/index.ts', '/index.tsx', '/index.web.js'];
// Any import/require specifier (relative OR bare package).
const SPEC_RE = /(?:require\(|import\s+[^'"]*?from\s+|import\(|export\s+[^'"]*?from\s+)\s*['"]([^'"]+)['"]/g;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// Node builtins (never in node_modules) + web-aliased packages we must NOT
// follow: `react-native` resolves to react-native-web on web, so chasing its
// static graph would drag in unused native code.
const SKIP_BARE = new Set([
  'react-native',
  'fs', 'path', 'os', 'util', 'events', 'stream', 'crypto', 'http', 'https',
  'net', 'tls', 'zlib', 'url', 'assert', 'buffer', 'child_process', 'module',
  'process', 'tty', 'readline', 'vm', 'dns', 'dgram', 'querystring', 'string_decoder',
  'worker_threads', 'perf_hooks', 'async_hooks', 'inspector', 'v8', 'timers', 'console',
]);
const isBuiltinish = (spec: string) =>
  SKIP_BARE.has(spec) || spec.startsWith('node:') || spec.startsWith('react-native/');
// Packages whose bare imports we DO chase (conditional/dynamic require()s live
// in the CLI + dev-server + bundler); elsewhere the runtime trace already read
// what's needed, so chasing bare imports just adds unused code.
const FOLLOW_BARE_FROM = /\/node_modules\/(@expo\/|expo\/|@react-native\/|metro[^/]*\/|@react-native-community\/)/;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function allFiles(vfs: any, dir: string, acc: string[] = []): string[] {
  let entries;
  try { entries = vfs.readdir(dir); } catch { return acc; }
  for (const e of entries) {
    const full = dir.endsWith('/') ? dir + e.name : dir + '/' + e.name;
    let st;
    try { st = vfs.stat(full); } catch { continue; }
    if (st.type === 'directory') allFiles(vfs, full, acc);
    else acc.push(full);
  }
  return acc;
}

function normJoin(dir: string, spec: string): string {
  const stack: string[] = [];
  for (const p of (dir + '/' + spec).split('/')) {
    if (p === '..') stack.pop();
    else if (p && p !== '.') stack.push(p);
  }
  return '/' + stack.join('/');
}

/** The `.../node_modules/<pkg>` root for a file, or '' if not under one. */
function pkgRootOf(f: string): string {
  const i = f.lastIndexOf('/node_modules/');
  if (i < 0) return '';
  const rest = f.slice(i + '/node_modules/'.length).split('/');
  const pkg = rest[0]?.startsWith('@') ? `${rest[0]}/${rest[1]}` : rest[0];
  return f.slice(0, i) + '/node_modules/' + pkg;
}

/**
 * Resolve a BARE import (`toqr`, `@scope/pkg/sub`) from `fromFile` to the files
 * it needs — walks up node_modules, resolves the subpath or the package's `main`
 * / index. Returns existing files (may be several: entry + package.json).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function resolveBare(vfs: any, nmSet: Set<string>, fromFile: string, spec: string): string[] {
  const seg = spec.split('/');
  const pkg = spec.startsWith('@') ? `${seg[0]}/${seg[1]}` : seg[0];
  const sub = spec.slice(pkg.length).replace(/^\//, '');
  // walk up dirs looking for node_modules/<pkg>
  let dir = fromFile.slice(0, fromFile.lastIndexOf('/'));
  let pkgDir = '';
  while (dir.length > 0) {
    const cand = `${dir}/node_modules/${pkg}`;
    if (nmSet.has(`${cand}/package.json`) || vfs.exists(cand)) { pkgDir = cand; break; }
    const up = dir.slice(0, dir.lastIndexOf('/'));
    if (up === dir) break;
    dir = up;
  }
  if (!pkgDir) return [];
  const out: string[] = [];
  const isFile = (p: string) => { try { return vfs.stat(p).type === 'file'; } catch { return false; } };
  const pj = `${pkgDir}/package.json`;
  if (nmSet.has(pj)) out.push(pj);
  const tryResolve = (base: string) => {
    for (const e of EXTS) { const c = base + e; if (nmSet.has(c) && isFile(c)) { out.push(c); return true; } }
    return false;
  };
  if (sub) {
    tryResolve(`${pkgDir}/${sub}`);
  } else {
    let main = '';
    try { main = JSON.parse(new TextDecoder().decode(vfs.readFile(pj) as Uint8Array)).main || ''; } catch { /* ignore */ }
    if (!main || !tryResolve(`${pkgDir}/${main.replace(/^\.\//, '')}`)) tryResolve(`${pkgDir}/index`);
  }
  return out;
}

/**
 * Fire a virtual HTTP GET into an in-VM port and await the response.
 *
 * Rejects (rather than resolving with a status) because callers here treat a
 * failed bundle as fatal to the trace.
 */
async function vmRequest(kernel: Kernel, port: number, url: string, timeoutMs = 120000): Promise<void> {
  if (!kernel.portRegistry.has(port)) throw new Error(`no handler on port ${port}`);
  const res = await dispatchRequest(
    kernel.portRegistry,
    port,
    { method: 'GET', url, headers: { host: `localhost:${port}` } },
    { timeoutMs },
  );
  if (res.statusCode === 504 && res.headers[LIFO_HEADER] === 'timeout') throw new Error('bundle timeout');
}

export async function pruneExpoModules(sandbox: Sandbox, opts: PruneOptions = {}): Promise<PruneResult> {
  const kernel = sandbox.kernel;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const vfs = kernel.vfs as any;
  const log = opts.onLog ?? (() => {});
  const port = opts.port ?? 8091;
  const isExpo = (d: string) => vfs.exists(join(d, 'node_modules/@expo/cli/build/bin/cli'));
  // Resolve the project dir: explicit opt, else the sandbox cwd, else scan the
  // cwd's immediate subdirs (the common "box at /home/user, app in ./my-app").
  let dir = resolve(sandbox.cwd, opts.projectDir ?? '.');
  if (!isExpo(dir)) {
    const candidates: string[] = [];
    try {
      for (const e of vfs.readdir(sandbox.cwd)) {
        if (e.type === 'directory') candidates.push(join(sandbox.cwd, e.name));
      }
    } catch { /* ignore */ }
    const found = candidates.find(isExpo);
    if (found) dir = found;
  }
  const nm = join(dir, 'node_modules');
  // Trace via the `expo` package's bin wrapper — the SAME entry `npm run web` /
  // `npx expo` resolve to. Tracing @expo/cli directly would prune expo/bin/cli.
  const expoBin = join(dir, 'node_modules/expo/bin/cli');
  const cli = vfs.exists(expoBin) ? expoBin : join(dir, 'node_modules/@expo/cli/build/bin/cli');
  if (!vfs.exists(nm)) throw new Error(`pruneExpoModules: no node_modules found (looked in ${dir})`);
  if (!vfs.exists(cli)) throw new Error(`pruneExpoModules: not an Expo project (missing expo/@expo cli) in ${dir}`);
  log(`Project: ${dir}`);

  const reads = new Set<string>();
  const existsHits = new Set<string>();
  const savedRead = vfs.readFile;
  const savedExists = vfs.exists;
  vfs.readFile = function (p: string, ...a: unknown[]) {
    if (typeof p === 'string') reads.add(p);
    return savedRead.call(this, p, ...a);
  };
  vfs.exists = function (p: string, ...a: unknown[]) {
    const r = savedExists.call(this, p, ...a);
    if (r && typeof p === 'string' && isNM(p)) existsHits.add(p);
    return r;
  };

  try {
    log(`Cold-starting a scratch web dev server on :${port} to trace…`);
    // Fire the dev server; do NOT await (long-running). -c clears the transform
    // cache so the trace is cold (captures every file Metro needs).
    void sandbox.shell
      .execute(`node ${cli} start --web --port ${port} -c ${dir}`, {
        cwd: dir,
        env: { ...sandbox.env, EXPO_OFFLINE: '1' },
      })
      .catch(() => {});

    const deadline = Date.now() + 120000;
    let bound = false;
    while (Date.now() < deadline) {
      if (kernel.portRegistry.has(port)) { bound = true; break; }
      await sleep(300);
    }
    if (!bound) throw new Error('pruneExpoModules: dev server did not bind in time');

    log('Bundling (cold) to trace the critical path…');
    await vmRequest(kernel, port, '/').catch(() => {});
    await vmRequest(kernel, port, `/index.bundle?platform=web&dev=true&hot=false`);
  } finally {
    vfs.readFile = savedRead;
    vfs.exists = savedExists;
  }

  // ── keep-set ──────────────────────────────────────────────────────────────
  const nmFiles = allFiles(vfs, nm);
  const nmSet = new Set(nmFiles);
  const keep = new Set<string>();
  for (const f of reads) if (isNM(f) && nmSet.has(f)) keep.add(f);
  for (const f of existsHits) if (nmSet.has(f)) keep.add(f);
  for (const f of nmFiles) {
    if (isPkgJson(f)) keep.add(f);                 // resolution reads these
    if (f.includes('/node_modules/.bin/')) keep.add(f); // bin shims npm/`run` use
  }

  // static import closure over kept JS files. Relative imports are always
  // followed. Bare (package) imports are chased only out of the CLI/bundler
  // packages — where conditional require()s live (@expo/cli/qr.js -> 'toqr') —
  // and transitively out of any package we pull in that way, so those are fully
  // closed too. We do NOT chase bare imports elsewhere (e.g. babel), whose
  // runtime-needed files the trace already read; following them adds dead code.
  const decoder = new TextDecoder();
  const isFile = (p: string) => { try { return vfs.stat(p).type === 'file'; } catch { return false; } };
  const followRoots = new Set<string>(); // extra package roots to chase bare from
  let frontier = [...keep].filter((f) => JS_RE.test(f));
  while (frontier.length) {
    const next: string[] = [];
    for (const f of frontier) {
      let src: string;
      try { src = decoder.decode(vfs.readFile(f) as Uint8Array); } catch { continue; }
      const fdir = dirname(f);
      const chaseBare = FOLLOW_BARE_FROM.test(f) || followRoots.has(pkgRootOf(f));
      for (const m of src.matchAll(SPEC_RE)) {
        const spec = m[1];
        let targets: string[];
        let bare = false;
        if (spec.startsWith('.')) {
          targets = [];
          const base = normJoin(fdir, spec);
          for (const e of EXTS) { const c = base + e; if (nmSet.has(c) && isFile(c)) targets.push(c); }
        } else if (isBuiltinish(spec) || !chaseBare) {
          continue;
        } else {
          targets = resolveBare(vfs, nmSet, f, spec);
          bare = true;
        }
        for (const cand of targets) {
          if (bare) followRoots.add(pkgRootOf(cand)); // fully close pulled-in pkgs
          if (!keep.has(cand)) {
            keep.add(cand);
            if (JS_RE.test(cand)) next.push(cand);
          }
        }
      }
    }
    frontier = next;
  }

  // ── prune ─────────────────────────────────────────────────────────────────
  let deleted = 0, freed = 0;
  for (const f of nmFiles) {
    if (keep.has(f)) continue;
    try { freed += vfs.stat(f).size ?? 0; } catch { /* ignore */ }
    try { vfs.unlink(f); deleted++; } catch { /* ignore */ }
  }

  const mb = (freed / 1048576).toFixed(1);
  log(`Kept ${keep.size} / ${nmFiles.length} node_modules files, deleted ${deleted} (~${mb} MB freed). Snapshot now.`);
  return { before: nmFiles.length, after: keep.size, deleted, freedBytes: freed };
}
