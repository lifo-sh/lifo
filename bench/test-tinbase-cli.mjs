#!/usr/bin/env node
/**
 * test-tinbase-cli.mjs — verify the tinbase CLI (npx tinbase --engine pgmem)
 * reads the supabase/ folder (migrations + seed.sql) and serves the Supabase
 * REST API — no server.mjs. Mirrors the new example.
 */
import http from 'node:http';
import { Sandbox } from '../packages/core/dist/index.js';

const CORS = 8828, PORT = 54321, APP = '/home/user/tinbase-todo';
const out = (s) => process.stdout.write(s);
const ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InRpbmJhc2UiLCJyb2xlIjoiYW5vbiIsImlhdCI6MTc4MzI3MzU0OSwiZXhwIjoyMDk4NjMzNTQ5fQ.yaaSYTyy2tRkx1myq06zU1ieZiWeJyq_hAZk2qCZEmk';
const server = http.createServer((q, r) => { (async () => { const t = new URL(q.url, 'http://x').searchParams.get('url'); if (!t) { r.statusCode = 400; return r.end('x'); } const u = await fetch(t, { headers: { accept: '*/*', 'user-agent': 'lifo' } }); r.statusCode = u.status; r.end(Buffer.from(await u.arrayBuffer())); })().catch((e) => { r.statusCode = 502; r.end(e.message); }); });
await new Promise((r) => server.listen(CORS, r));

const files = {
  [`${APP}/package.json`]: JSON.stringify({ name: 'tinbase-todo', version: '1.0.0', type: 'module', scripts: { dev: 'vite', build: 'vite build' }, dependencies: { vite: '^7.3.1', react: '^18.3.1', 'react-dom': '^18.3.1', '@vitejs/plugin-react': '^5.0.0', '@supabase/supabase-js': '^2.110.0' }, devDependencies: { tinbase: '^0.8.1', 'pg-mem': 'npm:@tinbase/pg-mem@^3.2.0' } }, null, 2),
  [`${APP}/supabase/migrations/20240101000000_create_todos.sql`]: `create table if not exists todos (\n  id bigint generated always as identity primary key,\n  title text not null,\n  done boolean not null default false,\n  created_at timestamptz not null default now()\n);\n`,
  [`${APP}/supabase/seed.sql`]: `insert into todos (title, done) values\n  ('Edit supabase/migrations to change the schema', false),\n  ('Add seed rows in supabase/seed.sql', true);\n`,
};

const sb = await Sandbox.create({ files, cwd: APP, persist: false, env: { LIFO_CORS_PROXY: `http://localhost:${CORS}/_cors?url=` } });
console.log('npm install …');
await sb.commands.run('npm install', { cwd: APP, onStdout: out, onStderr: out, timeout: 300000 });

console.log('\n$ npx tinbase --engine pgmem');
sb.shell.execute('npx tinbase --engine pgmem', { cwd: APP, env: sb.env, onStdout: out, onStderr: out }).catch((e) => console.log('cli err:', e.message));
let bound = false;
for (let i = 0; i < 60; i++) { if (sb.kernel.portRegistry.has(PORT)) { bound = true; break; } await new Promise((r) => setTimeout(r, 400)); }
console.log('\nport', PORT, 'bound:', bound);
if (!bound) { server.close(); process.exit(2); }
await new Promise((r) => setTimeout(r, 500));

const req = (method, url, body) => new Promise((res) => { const h = sb.kernel.portRegistry.get(PORT); const hdr = { host: `localhost:${PORT}`, apikey: ANON, authorization: 'Bearer ' + ANON, accept: 'application/json' }; if (body) { hdr['content-type'] = 'application/json'; hdr.prefer = 'return=representation'; hdr['content-length'] = String(new TextEncoder().encode(body).length); } const v = { statusCode: 200, headers: {}, body: '' }; h({ method, url, headers: hdr, body: body || '' }, v); v._donePromise ? v._donePromise.then(() => res(v)) : res(v); });
const bodyOf = (v) => (v.bodyBytes ? new TextDecoder().decode(v.bodyBytes) : v.body);

const list = await req('GET', '/rest/v1/todos?select=*&order=id');
const listBody = bodyOf(list);
console.log('\nGET /rest/v1/todos ->', list.statusCode, listBody.slice(0, 260));
// POST exercises request-body reading (the CLI reads it via async iteration).
const ins = await req('POST', '/rest/v1/todos', JSON.stringify({ title: 'from REST' }));
console.log('POST /rest/v1/todos ->', ins.statusCode, bodyOf(ins).slice(0, 160));
const studio = await req('GET', '/_/');
console.log('GET /_/ (Studio) ->', studio.statusCode, '(', bodyOf(studio).length, 'bytes )');

let rows = []; try { rows = JSON.parse(listBody); } catch { /* */ }
const ok = list.statusCode === 200 && Array.isArray(rows) && rows.length === 2 && rows.some((r) => r.title.includes('seed rows'))
  && (ins.statusCode === 201 || ins.statusCode === 200) && bodyOf(ins).includes('from REST')
  && studio.statusCode === 200;
console.log('\n' + (ok ? '✅ PASS — npx tinbase --engine pgmem: supabase/ folder + REST GET/POST + Studio (no server.mjs)' : '❌ FAIL'));
server.close();
process.exit(ok ? 0 : 1);
