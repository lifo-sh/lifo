/**
 * browser-metro — a Metro REPLACEMENT that runs inside Lifo.
 *
 * Instead of downloading node_modules and running real Metro/Babel in the VM
 * (heavy on mobile), this bundles the project with the `browser-metro` library:
 * user files are sucrase-transformed in-realm and npm packages are fetched
 * PRE-BUNDLED from the hosted package server (esm.reactnative.run). The result
 * is a small (~2MB) self-contained bundle served on a virtual port, so the
 * existing preview (service-worker or SW-free) shows it unchanged.
 *
 * It's a switchable OPTION — run this instead of `expo start --web` when you
 * want the light/mobile path; keep real Metro for the power cases.
 *
 * Usage: browser-metro [projectDir] [--port <n>]
 *
 * Ported from RapidNative's production integration (rapidnative-website):
 * the expo-web plugin (react-native→react-native-web alias, React auto-import,
 * className patch), the runtime shims (browser-metro-shims.ts), and the
 * expo-router synthetic entry.
 */
import {
  IncrementalBundler,
  VirtualFS,
  typescriptTransformer,
  createReactRefreshTransformer,
  createDataBxPathPlugin,
  createExpoWebShimsPlugin,
  createUnsupportedWebPackagesPlugin,
} from 'browser-metro';
import type { FileMap, BundlerConfig, BundlerPlugin, FileChange } from 'browser-metro';
import type { Command } from '../types.js';
import type { Kernel, VirtualRequest, VirtualResponse } from '../../kernel/index.js';
import { resolve } from '../../utils/path.js';
import {
  GLOBALS_PREAMBLE, CLASSNAME_PATCH_MODULE, NATIVEWIND_SHIM,
  EXPO_FONT_SHIM, REANIMATED_SHIM, WEBVIEW_SHIM, buildExpoConstantsShim,
} from './browser-metro-shims.js';

const PACKAGE_SERVER = 'https://esm.reactnative.run';
const SOURCE_EXTS = ['web.tsx', 'web.ts', 'web.jsx', 'web.js', 'tsx', 'ts', 'jsx', 'js', 'json'];
// External assets get { uri: ASSET_PREFIX + <vfs path> }; the dev server serves
// their bytes at that prefix (preview routes root-absolute paths to this port).
const ASSET_PREFIX = '/__bm_assets';
const MIME: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  svg: 'image/svg+xml', ico: 'image/x-icon', bmp: 'image/bmp',
  ttf: 'font/ttf', otf: 'font/otf', woff: 'font/woff', woff2: 'font/woff2',
  mp4: 'video/mp4', webm: 'video/webm', mp3: 'audio/mpeg', wav: 'audio/wav',
};
const mimeOf = (p: string) => MIME[p.split('?')[0].split('.').pop()?.toLowerCase() ?? ''] ?? 'application/octet-stream';
const ASSET_EXT = /\.(png|jpe?g|gif|webp|ttf|otf|woff2?|mp4|mp3|wav|bin|ico)$/i;
const SKIP_SEG = /(^|\/)(node_modules|\.git|\.expo|dist|\.cache|\.next)(\/|$)/;

// Virtual paths the expo-web plugin resolves shimmed native packages to.
const EXPO_CONSTANTS_VPATH = '/__shims__/expo-constants.js';
const REANIMATED_VPATH = '/__shims__/react-native-reanimated.js';
const WORKLETS_VPATH = '/__shims__/react-native-worklets.js';
const WEBVIEW_VPATH = '/__shims__/react-native-webview.js';

const isJSX = (f: string) => f.endsWith('.tsx') || f.endsWith('.jsx');
const hasReactImport = (s: string) => /\bimport\s+React\b/.test(s) || /\bimport\s+\*\s+as\s+React\b/.test(s);

function makeExpoWebPlugin(): BundlerPlugin {
  return {
    name: 'expo-web',
    transformSource({ src, filename }) {
      if (filename.endsWith('.json')) return { src: `module.exports = ${src};` };
      let m = src, changed = false;
      if (isJSX(filename) && !hasReactImport(src)) { m = 'import React from "react";\n' + m; changed = true; }
      if (filename === '/index.tsx' || filename === '/index.ts' || filename === '/index.js') {
        m = 'require("__classname-patch__");\n' + m; changed = true;
      }
      return changed ? { src: m } : null;
    },
    transformOutput({ code }) { return { code: GLOBALS_PREAMBLE + code }; },
    resolveRequest(_ctx, name) {
      if (name === 'expo-constants') return EXPO_CONSTANTS_VPATH;
      if (name === 'react-native-reanimated') return REANIMATED_VPATH;
      if (name === 'react-native-worklets') return WORKLETS_VPATH;
      if (name === 'react-native-webview') return WEBVIEW_VPATH;
      return null;
    },
    moduleAliases() { return { 'react-native': 'react-native-web' }; },
    shimModules() {
      return {
        '__classname-patch__': CLASSNAME_PATCH_MODULE,
        nativewind: NATIVEWIND_SHIM,
        'react-native-css-interop': 'module.exports = {};',
        'expo-font': EXPO_FONT_SHIM,
      };
    },
  };
}

// ── expo-router synthetic entry (ported) ─────────────────────────────────────
function buildExpoRouteContext(vfs: VirtualFS): string {
  const routeExts = new Set(['tsx', 'ts', 'jsx', 'js']);
  const entries: { contextKey: string; requirePath: string }[] = [];
  for (const p of vfs.list()) {
    if (!p.startsWith('/app/')) continue;
    const ext = p.split('.').pop() || '';
    if (!routeExts.has(ext)) continue;
    entries.push({ contextKey: './' + p.slice('/app/'.length), requirePath: '.' + p.replace(/\.[^.]+$/, '') });
  }
  const loads = entries
    .map((e) => `  try { modules["${e.contextKey}"] = require("${e.requirePath}"); } catch(e) { moduleErrors["${e.contextKey}"] = e; }`)
    .join('\n');
  return `var modules = {};
var moduleErrors = {};
function ctx(id) { if (id in moduleErrors) throw moduleErrors[id]; return modules[id]; }
ctx.keys = function() { return Object.keys(modules).concat(Object.keys(moduleErrors)); };
module.exports = ctx;
${loads}
`;
}

function buildExpoRouterEntry(): string {
  return `import { registerRootComponent } from "expo";
import { ExpoRoot } from "expo-router";
import React from "react";
function App() {
  var ctx = require("./__expo_ctx");
  if (typeof ctx !== "function" || typeof ctx.keys !== "function") return null;
  return React.createElement(ExpoRoot, { context: ctx });
}
if (!window.__EXPO_ROOT_REGISTERED) {
  registerRootComponent(App);
  window.__EXPO_ROOT_REGISTERED = true;
}
`;
}

function ensureEntry(vfs: VirtualFS): string | null {
  const entry = vfs.getEntryFile();
  if (entry) return entry;
  if (vfs.getPackageMain() === 'expo-router/entry') {
    vfs.write('/__expo_ctx.js', buildExpoRouteContext(vfs));
    vfs.write('/index.tsx', buildExpoRouterEntry());
    return '/index.tsx';
  }
  return null;
}

// ── Lifo VFS → browser-metro FileMap ─────────────────────────────────────────
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function readFileMap(vfs: any, dir: string): FileMap {
  const decoder = new TextDecoder();
  const fm: FileMap = {};
  const walk = (abs: string) => {
    let entries;
    try { entries = vfs.readdir(abs); } catch { return; }
    for (const e of entries) {
      const full = abs.endsWith('/') ? abs + e.name : abs + '/' + e.name;
      const rel = full.slice(dir.length) || '/' + e.name;
      if (SKIP_SEG.test(rel)) continue;
      let st;
      try { st = vfs.stat(full); } catch { continue; }
      if (st.type === 'directory') { walk(full); continue; }
      if (ASSET_EXT.test(rel)) { fm[rel] = { content: '', isExternal: true }; continue; }
      try { fm[rel] = { content: decoder.decode(vfs.readFile(full)), isExternal: false }; } catch { /* skip */ }
    }
  };
  walk(dir);
  // Inject shim modules resolved via the expo-web plugin's resolveRequest.
  fm[EXPO_CONSTANTS_VPATH] = { content: buildExpoConstantsShim(fm['/app.json']?.content), isExternal: false };
  fm[REANIMATED_VPATH] = { content: REANIMATED_SHIM, isExternal: false };
  fm[WORKLETS_VPATH] = { content: 'module.exports = {};', isExternal: false };
  fm[WEBVIEW_VPATH] = { content: WEBVIEW_SHIM, isExternal: false };
  return fm;
}

function publicEnv(env: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (/^(EXPO_PUBLIC_|NEXT_PUBLIC_)/.test(k)) out[k] = v;
  return out;
}

// The HMR client: polls /__bmhmr and either reloads (a rebuild that can't be
// hot-applied) or forwards each hot update to the bundle's in-iframe HMR runtime
// via window.postMessage({type:'hmr-update', …}) — which does React Refresh.
function pageHtml(bundleVersion: number, hmrSeq: number): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>html,body{height:100%;margin:0}body{overflow:hidden}#root{display:flex;height:100%;flex:1}</style>
<script src="https://cdn.tailwindcss.com"></script>
<script>(function(){var B=${bundleVersion},H=${hmrSeq};function p(){fetch('/__bmhmr?b='+B+'&h='+H,{cache:'no-store'}).then(function(r){return r.json();}).then(function(d){if(d.reload){location.reload();return;}if(d.updates){for(var i=0;i<d.updates.length;i++){var u=d.updates[i];window.postMessage({type:'hmr-update',updatedModules:u.update.updatedModules,removedModules:u.update.removedModules,reverseDepsMap:u.update.reverseDepsMap},'*');H=u.seq;}}setTimeout(p,300);}).catch(function(){setTimeout(p,800);});}p();})();</script>
</head><body><div id="root"></div><script src="/index.bundle"></script></body></html>`;
}

interface HmrEntry { seq: number; update: { updatedModules: Record<string, string>; removedModules: string[]; reverseDepsMap?: Record<string, string[]> } }

export function createBrowserMetroCommand(kernel: Kernel): Command {
  return async (ctx) => {
    const rest = ctx.args.slice(1);
    if (rest.includes('--help') || rest.includes('-h')) {
      ctx.stdout.write('Usage: browser-metro [projectDir] [--port <n>]\n\nBundle an Expo web app with browser-metro (light Metro replacement) and serve it.\n');
      return 0;
    }
    const pIdx = rest.indexOf('--port');
    const port = Number(pIdx >= 0 ? rest[pIdx + 1] : 8081) || 8081;
    const dirArg = rest.find((a) => !a.startsWith('-') && a !== String(port)) || '.';
    const dir = resolve(ctx.cwd, dirArg);
    if (!kernel.vfs.exists(dir)) { ctx.stderr.write(`browser-metro: no such directory: ${dir}\n`); return 1; }

    const config: BundlerConfig = {
      resolver: { sourceExts: SOURCE_EXTS },
      transformer: createReactRefreshTransformer(typescriptTransformer),
      server: { packageServerUrl: PACKAGE_SERVER },
      hmr: { enabled: true, reactRefresh: true },
      plugins: [createDataBxPathPlugin(), makeExpoWebPlugin(), createExpoWebShimsPlugin(), createUnsupportedWebPackagesPlugin()],
      routerShim: true,
      assetPublicPath: ASSET_PREFIX,
      env: publicEnv(ctx.env),
    };

    // Assets live in the VFS (not on an HTTP origin like RapidNative's Supabase
    // Storage), so we read the bytes and materialize each as a blob: URL, then
    // rewrite the bundle's `${ASSET_PREFIX}/…` URIs (in the full bundle AND in
    // hot-update module code) to those blobs — the same-origin preview iframe
    // uses them directly. In Node (no createObjectURL) we keep the paths and
    // serve bytes via the port route as a fallback.
    const canBlob = typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function' && typeof Blob !== 'undefined';
    const assetBlobs = new Map<string, string>(); // uri -> blob URL
    const revokeAssetBlobs = () => { for (const u of assetBlobs.values()) { try { URL.revokeObjectURL(u); } catch { /* ignore */ } } assetBlobs.clear(); };
    const ASSET_URI_RE = new RegExp(ASSET_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '/[^"\'`\\s)]+', 'g');
    const materializeAssets = (code: string): string => {
      if (!canBlob) return code;
      for (const uri of new Set(code.match(ASSET_URI_RE) || [])) {
        let blobUrl = assetBlobs.get(uri);
        if (!blobUrl) {
          try {
            const bytes = kernel.vfs.readFile(dir + uri.slice(ASSET_PREFIX.length)) as Uint8Array;
            blobUrl = URL.createObjectURL(new Blob([bytes as BlobPart], { type: mimeOf(uri) }));
            assetBlobs.set(uri, blobUrl);
          } catch { continue; }
        }
        code = code.split(uri).join(blobUrl);
      }
      return code;
    };

    // ── incremental bundler over a persistent VFS ────────────────────────────
    const bvfs = new VirtualFS(readFileMap(kernel.vfs, dir));
    const entry = ensureEntry(bvfs);
    if (!entry) { ctx.stderr.write('browser-metro: no entry file (index/App or expo-router/entry) found\n'); return 1; }
    const bundler = new IncrementalBundler(bvfs, config);

    let currentBundle = '';   // latest full bundle (for fresh loads / reloads)
    let bundleVersion = 1;    // bumped when a rebuild can't be hot-applied → clients reload
    let hmrSeq = 0;           // bumped per hot update
    let hmrLog: HmrEntry[] = [];

    ctx.stdout.write(`browser-metro: bundling ${dir} (packages from ${PACKAGE_SERVER})…\n`);
    const t0 = Date.now();
    try {
      const r = await bundler.build(entry);
      currentBundle = materializeAssets(r.bundle);
    } catch (e) {
      ctx.stderr.write(`browser-metro: bundle failed: ${e instanceof Error ? e.message : String(e)}\n`);
      return 1;
    }
    ctx.stdout.write(`browser-metro: bundled in ${((Date.now() - t0) / 1000).toFixed(1)}s (${(currentBundle.length / 1048576).toFixed(2)} MB). Serving on port ${port} (HMR on).\n`);

    const handler = (req: VirtualRequest, res: VirtualResponse): void => {
      const [path, query] = req.url.split('?');
      if (path === '/index.bundle' || path.endsWith('/index.bundle')) {
        res.statusCode = 200; res.headers['content-type'] = 'application/javascript; charset=utf-8'; res.body = currentBundle;
      } else if (path === '/__bmhmr') {
        const q = new URLSearchParams(query || '');
        const cb = Number(q.get('b') || 0), ch = Number(q.get('h') || 0);
        res.statusCode = 200; res.headers['content-type'] = 'application/json';
        res.body = cb < bundleVersion
          ? JSON.stringify({ reload: true, bundleVersion })
          : JSON.stringify({ reload: false, bundleVersion, hmrSeq, updates: hmrLog.filter((u) => u.seq > ch) });
      } else if (path.startsWith(ASSET_PREFIX + '/')) {
        const full = dir + path.slice(ASSET_PREFIX.length);
        try {
          res.statusCode = 200; res.headers['content-type'] = mimeOf(path); res.headers['cache-control'] = 'no-cache';
          res.bodyBytes = kernel.vfs.readFile(full) as Uint8Array;
        } catch {
          res.statusCode = 404; res.headers['content-type'] = 'text/plain'; res.body = `asset not found: ${path}`;
        }
      } else {
        res.statusCode = 200; res.headers['content-type'] = 'text/html; charset=utf-8'; res.body = pageHtml(bundleVersion, hmrSeq);
      }
    };
    kernel.portRegistry.set(port, handler);

    // ── file-watch → incremental rebuild → HMR (or reload) ───────────────────
    const decoder = new TextDecoder();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let building = false;
    let pending = new Set<string>();

    const flush = async (): Promise<void> => {
      if (building) return;                 // a rebuild is running; the timer will re-fire
      const paths = [...pending]; pending = new Set();
      const changes: FileChange[] = [];
      let routeStructureChanged = false;
      for (const abs of paths) {
        const rel = abs.slice(dir.length);
        if (!rel.startsWith('/') || SKIP_SEG.test(rel)) continue;
        if (!kernel.vfs.exists(abs)) {
          if (bvfs.exists(rel)) { bvfs.delete(rel); changes.push({ path: rel, type: 'delete' }); if (rel.startsWith('/app/')) routeStructureChanged = true; }
          continue;
        }
        if (ASSET_EXT.test(rel)) { assetBlobs.delete(ASSET_PREFIX + rel); continue; }
        const existed = bvfs.exists(rel);
        try { bvfs.write(rel, decoder.decode(kernel.vfs.readFile(abs) as Uint8Array)); } catch { continue; }
        changes.push({ path: rel, type: existed ? 'update' : 'create' });
        if (!existed && rel.startsWith('/app/')) routeStructureChanged = true;
      }
      if (changes.length === 0) return;
      // expo-router: adding/removing a route file regenerates the route context.
      if (routeStructureChanged && bvfs.getPackageMain() === 'expo-router/entry') {
        bvfs.write('/__expo_ctx.js', buildExpoRouteContext(bvfs));
        changes.push({ path: '/__expo_ctx.js', type: 'update' });
      }
      building = true;
      try {
        const r = await bundler.rebuild(changes);
        if (r.type === 'full' || !r.hmrUpdate || r.hmrUpdate.requiresReload) {
          currentBundle = materializeAssets(r.bundle); bundleVersion++; hmrLog = [];
          ctx.stdout.write(`browser-metro: full rebuild → reload (v${bundleVersion}).\n`);
        } else {
          currentBundle = materializeAssets(r.bundle);
          const updatedModules: Record<string, string> = {};
          for (const [k, v] of Object.entries(r.hmrUpdate.updatedModules)) updatedModules[k] = materializeAssets(v);
          hmrLog.push({ seq: ++hmrSeq, update: { updatedModules, removedModules: r.hmrUpdate.removedModules, reverseDepsMap: r.hmrUpdate.reverseDepsMap } });
          if (hmrLog.length > 300) hmrLog = hmrLog.slice(-300);
          ctx.stdout.write(`browser-metro: hot update (${Object.keys(updatedModules).length} module(s)).\n`);
        }
      } catch (e) {
        ctx.stderr.write(`browser-metro: rebuild failed: ${e instanceof Error ? e.message : String(e)}\n`);
      } finally {
        building = false;
        if (pending.size) { clearTimeout(timer); timer = setTimeout(() => { void flush(); }, 50); }
      }
    };

    const unwatch = kernel.vfs.watch((event: { path?: string; oldPath?: string }) => {
      if (event.path) pending.add(event.path);
      if (event.oldPath) pending.add(event.oldPath);
      clearTimeout(timer);
      timer = setTimeout(() => { void flush(); }, 200);
    });

    // Run until the command is aborted (Ctrl-C / kill).
    await new Promise<void>((r) => {
      if (ctx.signal.aborted) return r();
      ctx.signal.addEventListener('abort', () => r(), { once: true });
    });
    clearTimeout(timer);
    unwatch();
    revokeAssetBlobs();
    kernel.portRegistry.delete(port);
    return 0;
  };
}
