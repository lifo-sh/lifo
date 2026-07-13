#!/usr/bin/env node
/**
 * measure-vite.mjs — quantify a Vite + React app's footprint in the VM, to
 * decide whether Vite needs prune (like Expo) and/or a hosted pre-bundle.
 * Reports: node_modules size, full snapshot size, and the read-based keep-set
 * (what Vite dev actually touches) size + snapshot.
 */
import http from 'node:http';
import { Sandbox, exportVfsSnapshot } from '../packages/core/dist/index.js';

const CORS = 8823, PORT = 5173, APP = '/home/user/vite-app';
const out = (s) => process.stdout.write(s);
const server = http.createServer((q, r) => { (async () => { const t = new URL(q.url, 'http://x').searchParams.get('url'); if (!t) { r.statusCode = 400; return r.end('x'); } const u = await fetch(t, { headers: { accept: '*/*', 'user-agent': 'lifo' } }); r.statusCode = u.status; r.end(Buffer.from(await u.arrayBuffer())); })().catch((e) => { r.statusCode = 502; r.end(e.message); }); });
await new Promise((r) => server.listen(CORS, r));

const files = {
  [`${APP}/package.json`]: JSON.stringify({ name: 'vite-app', version: '1.0.0', type: 'module', scripts: { dev: 'vite', build: 'vite build' }, dependencies: { react: '^18.3.1', 'react-dom': '^18.3.1', vite: '^7.3.1', '@vitejs/plugin-react': '^5.0.0' } }, null, 2),
  [`${APP}/vite.config.js`]: `import { defineConfig } from 'vite'\nimport react from '@vitejs/plugin-react'\nexport default defineConfig({ plugins: [react()] })\n`,
  [`${APP}/index.html`]: `<!DOCTYPE html><html><head><title>vite</title></head><body><div id="root"></div><script type="module" src="/src/main.jsx"></script></body></html>`,
  [`${APP}/src/main.jsx`]: `import React from 'react';\nimport { createRoot } from 'react-dom/client';\nimport App from './App.jsx';\ncreateRoot(document.getElementById('root')).render(<App />);\n`,
  [`${APP}/src/App.jsx`]: `import { useState } from 'react';\nexport default function App(){ const [n,setN]=useState(0); return <button onClick={()=>setN(n+1)}>count {n}</button>; }\n`,
};

const sb = await Sandbox.create({ files, cwd: APP, persist: false, env: { LIFO_CORS_PROXY: `http://localhost:${CORS}/_cors?url=` } });
const vfs = sb.kernel.vfs;

console.log('npm install …');
await sb.commands.run('npm install', { cwd: APP, onStdout: out, onStderr: out, timeout: 300000 });

// --- walk helpers ---
function walk(dir, acc = []) { let es; try { es = vfs.readdir(dir); } catch { return acc; } for (const e of es) { const f = dir + '/' + e.name; let st; try { st = vfs.stat(f); } catch { continue; } if (st.type === 'directory') walk(f, acc); else acc.push([f, st.size ?? 0]); } return acc; }
const mb = (b) => (b / 1048576).toFixed(1) + ' MB';
const sum = (arr) => arr.reduce((a, [, s]) => a + s, 0);

const nmFiles = walk(`${APP}/node_modules`);
console.log(`\nnode_modules: ${nmFiles.length} files, ${mb(sum(nmFiles))}`);

// biggest packages
const byPkg = {};
for (const [f, s] of nmFiles) { const i = f.indexOf('/node_modules/'); const rest = f.slice(i + 14).split('/'); const pkg = rest[0]?.startsWith('@') ? rest[0] + '/' + rest[1] : rest[0]; byPkg[pkg] = (byPkg[pkg] || 0) + s; }
console.log('top packages by size:');
for (const [p, s] of Object.entries(byPkg).sort((a, b) => b[1] - a[1]).slice(0, 12)) console.log(`  ${mb(s).padStart(9)}  ${p}`);

// --- full snapshot size ---
const fullSnap = await exportVfsSnapshot(vfs);
console.log(`\nFULL snapshot (tar.gz): ${mb(fullSnap.byteLength)}`);

// --- trace what vite dev reads ---
const reads = new Set(), existsHits = new Set();
const savedRead = vfs.readFile, savedExists = vfs.exists;
vfs.readFile = function (p, ...a) { if (typeof p === 'string') reads.add(p); return savedRead.call(this, p, ...a); };
vfs.exists = function (p, ...a) { const r = savedExists.call(this, p, ...a); if (r && typeof p === 'string' && p.includes('/node_modules/')) existsHits.add(p); return r; };

console.log('\nstarting vite dev + crawling to trigger dep optimization…');
sb.shell.execute('npx vite --port ' + PORT, { cwd: APP, env: sb.env, onStdout: out, onStderr: out }).catch((e) => console.log('vite err:', e.message));
for (let i = 0; i < 60; i++) { if (sb.kernel.portRegistry.has(PORT)) break; await new Promise((r) => setTimeout(r, 400)); }
if (!sb.kernel.portRegistry.has(PORT)) { console.log('vite did not bind'); server.close(); process.exit(2); }

const req = (url) => new Promise((res) => { const h = sb.kernel.portRegistry.get(PORT); const v = { statusCode: 200, headers: {}, body: '' }; h({ method: 'GET', url, headers: { host: `localhost:${PORT}` }, body: '' }, v); v._donePromise ? v._donePromise.then(() => res(v)) : res(v); });
const bodyOf = (v) => (v.bodyBytes ? new TextDecoder().decode(v.bodyBytes) : v.body);

// crawl: /, entry, and follow a couple import levels to exercise the module graph
async function crawl(url, depth) { if (depth < 0) return; const r = await req(url); const body = bodyOf(r); const specs = [...body.matchAll(/(?:from|import)\s*["']([^"']+)["']/g)].map((m) => m[1]).filter((s) => s.startsWith('/') || s.startsWith('.')); for (const s of specs.slice(0, 12)) { try { await crawl(new URL(s, 'http://x' + url).pathname, depth - 1); } catch { /* */ } } }
await req('/');
await crawl('/src/main.jsx', 2);
await new Promise((r) => setTimeout(r, 2000)); // let dep optimizer settle
vfs.readFile = savedRead; vfs.exists = savedExists;

// --- keep-set: reads ∪ exists ∪ package.json (in node_modules) ---
const nmSet = new Map(nmFiles);
const keep = new Set();
for (const f of reads) if (f.includes('/node_modules/') && nmSet.has(f)) keep.add(f);
for (const f of existsHits) if (nmSet.has(f)) keep.add(f);
for (const [f] of nmFiles) if (f.endsWith('/package.json')) keep.add(f);
let keepBytes = 0; for (const f of keep) keepBytes += nmSet.get(f) || 0;

console.log(`\nvite dev read-based keep-set: ${keep.size} / ${nmFiles.length} files, ${mb(keepBytes)} (${(100 * keep.size / nmFiles.length).toFixed(0)}% of files, ${(100 * keepBytes / sum(nmFiles)).toFixed(0)}% of bytes)`);
console.log('kept top packages:');
const keepByPkg = {}; for (const f of keep) { const i = f.indexOf('/node_modules/'); const rest = f.slice(i + 14).split('/'); const pkg = rest[0]?.startsWith('@') ? rest[0] + '/' + rest[1] : rest[0]; keepByPkg[pkg] = (keepByPkg[pkg] || 0) + (nmSet.get(f) || 0); }
for (const [p, s] of Object.entries(keepByPkg).sort((a, b) => b[1] - a[1]).slice(0, 10)) console.log(`  ${mb(s).padStart(9)}  ${p}`);

// pruned snapshot: delete non-keep node_modules files, measure the gz size
let del = 0; for (const [f] of nmFiles) { if (!keep.has(f)) { try { vfs.unlink(f); del++; } catch { /* */ } } }
const prunedSnap = await exportVfsSnapshot(vfs);

console.log('\n===== SUMMARY (Vite + React) =====');
console.log(`node_modules full:        ${nmFiles.length} files, ${mb(sum(nmFiles))}`);
console.log(`full snapshot (gz):       ${mb(fullSnap.byteLength)}`);
console.log(`vite-read keep-set:       ${keep.size} files, ${mb(keepBytes)}`);
console.log(`pruned snapshot (gz):     ${mb(prunedSnap.byteLength)}  (deleted ${del} node_modules files)`);
console.log(`\nfor reference, a blank Expo web app snapshot is ~90 MB (pruned ~8 MB).`);
server.close();
process.exit(0);
