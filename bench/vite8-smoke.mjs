#!/usr/bin/env node
/**
 * vite8-smoke.mjs — Vite 8 (Rolldown) end to end in a Node-hosted box.
 *
 * Vite 8 runs on Rolldown, a Rust addon a box can only load as its napi-rs WebAssembly build
 * (`@rolldown/binding-wasm32-wasi`, threads and all; see packages/core/src/node-compat/
 * napi-wasi). This installs a Vite 8 + React + TypeScript app from the registry, starts the dev
 * server, fetches a transformed TSX module and the pre-bundled react-dom, then runs
 * `vite build`. Exits non-zero on any failure.
 *
 *   pnpm --filter @lifo-sh/core build
 *   node bench/vite8-smoke.mjs                       # needs network (npm registry)
 *   VITE8_SMOKE_CACHE=/tmp/vite8.tgz node bench/vite8-smoke.mjs   # reuse the install
 */
import http from 'node:http';
import fs from 'node:fs';
import { Sandbox } from '../packages/core/dist/index.js';

const T0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - T0) / 1000).toFixed(1)}s]`, ...a);
const fail = (msg) => { log(`FAIL: ${msg}`); process.exit(1); };
// A stuck addon thread can block the event loop for good; don't hang CI with it.
setTimeout(() => fail('timed out'), 10 * 60 * 1000).unref();

const CORS = 8826, PORT = 5173, APP = '/home/user/vite8-app';
const CACHE = process.env.VITE8_SMOKE_CACHE;
const server = http.createServer((q, r) => {
  (async () => {
    const t = new URL(q.url, 'http://x').searchParams.get('url');
    const u = await fetch(t, { headers: { accept: '*/*' } });
    r.statusCode = u.status;
    r.end(Buffer.from(await u.arrayBuffer()));
  })().catch((e) => { r.statusCode = 502; r.end(e.message); });
});
await new Promise((r) => server.listen(CORS, r));

const files = {
  [`${APP}/package.json`]: JSON.stringify({
    name: 'vite8-app', type: 'module',
    dependencies: { react: '^19.0.0', 'react-dom': '^19.0.0', vite: '^8.0.0', '@vitejs/plugin-react': '^6.0.0' },
  }, null, 2),
  [`${APP}/vite.config.js`]: `import { defineConfig } from 'vite'\nimport react from '@vitejs/plugin-react'\nexport default defineConfig({ plugins: [react()] })\n`,
  [`${APP}/index.html`]: `<!DOCTYPE html><html><head><title>vite</title></head><body><div id="root"></div><script type="module" src="/src/main.tsx"></script></body></html>`,
  [`${APP}/src/main.tsx`]: `import { createRoot } from 'react-dom/client';\nimport App from './App';\ncreateRoot(document.getElementById('root')!).render(<App />);\n`,
  [`${APP}/src/App.tsx`]: `import { useState } from 'react';\nexport default function App() { const [n, setN] = useState<number>(0); return <button onClick={() => setN(n + 1)}>count {n}</button>; }\n`,
};

const sb = await Sandbox.create({ files, cwd: APP, persist: false, env: { LIFO_CORS_PROXY: `http://localhost:${CORS}/_cors?url=` } });
const vfs = sb.kernel.vfs;
if (CACHE && fs.existsSync(CACHE)) {
  await sb.importSnapshot(new Uint8Array(fs.readFileSync(CACHE)));
  log('restored the installed app from', CACHE);
} else {
  log('npm install …');
  const r = await sb.commands.run('npm install', { cwd: APP, onStdout: () => {}, onStderr: (s) => process.stdout.write(s), timeout: 600000 });
  if (r.exitCode !== 0) fail(`npm install exited ${r.exitCode}`);
  log('installed');
  if (CACHE) fs.writeFileSync(CACHE, await sb.exportSnapshot());
}
const version = (p) => { try { return JSON.parse(vfs.readFileString(`${APP}/node_modules/${p}/package.json`)).version; } catch { return null; } };
for (const p of ['vite', 'rolldown', '@rolldown/binding-wasm32-wasi']) {
  if (!version(p)) fail(`${p} is not installed`);
  log(`  ${p}@${version(p)}`);
}

// ── dev server ──
const out = (s) => process.stdout.write(s);
let devExit = null;
sb.shell.execute(`npx vite --port ${PORT}`, { cwd: APP, env: sb.env, onStdout: out, onStderr: out })
  .then((c) => { devExit = c; }, (e) => { devExit = e; });
for (let i = 0; i < 600 && !sb.kernel.portRegistry.has(PORT) && devExit === null; i++) await new Promise((r) => setTimeout(r, 100));
if (!sb.kernel.portRegistry.has(PORT)) fail(`vite dev did not start: ${JSON.stringify(devExit)?.slice(0, 1000)}`);
log('dev server listening');

const get = async (url) => {
  const res = await sb.fetch(`http://localhost:${PORT}${url}`);
  return { status: res.status, body: await res.text() };
};
const main = await get('/src/main.tsx');
if (main.status !== 200 || main.body.includes('<App />')) fail(`/src/main.tsx -> ${main.status}, JSX not transformed`);
log(`GET /src/main.tsx -> ${main.status} (${main.body.length} B, transformed)`);
const dep = main.body.match(/\/node_modules\/\.vite\/deps\/react-dom_client\.js[^"']*/)?.[0];
if (!dep) fail(`main.tsx does not import a pre-bundled react-dom:\n${main.body.slice(0, 900)}`);
const depRes = await get(dep);
if (depRes.status !== 200 || depRes.body.length < 10000) fail(`${dep} -> ${depRes.status} (${depRes.body.length} B)`);
log(`GET ${dep.split('?')[0]} -> ${depRes.status} (${depRes.body.length} B, pre-bundled by Rolldown)`);
log(`host memory with the dev server up: ${Math.round(process.memoryUsage().rss / 1048576)} MB rss`);

// ── production build ──
const build = await sb.commands.run('npx vite build', { cwd: APP, onStdout: out, onStderr: out, timeout: 300000 });
if (build.exitCode !== 0) fail(`vite build exited ${build.exitCode}`);
const assets = vfs.readdir(`${APP}/dist/assets`).map((e) => e.name);
if (!assets.some((n) => n.endsWith('.js'))) fail('vite build wrote no JS');
log(`vite build -> dist/assets: ${assets.join(', ')}`);

log('OK');
server.close();
process.exit(0);
