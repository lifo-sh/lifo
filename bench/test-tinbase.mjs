#!/usr/bin/env node
/**
 * test-tinbase.mjs — verify the tinbase example's real supabase/ folder is
 * applied: server.mjs reads supabase/migrations/*.sql + seed.sql, creates the
 * todos table, seeds it, and serves it over the Supabase-compatible REST API.
 */
import http from 'node:http';
import { Sandbox } from '../packages/core/dist/index.js';

const CORS = 8825, PORT = 54321, APP = '/home/user/tinbase-todo';
const out = (s) => process.stdout.write(s);
const ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InRpbmJhc2UiLCJyb2xlIjoiYW5vbiIsImlhdCI6MTc4MzI3MzU0OSwiZXhwIjoyMDk4NjMzNTQ5fQ.yaaSYTyy2tRkx1myq06zU1ieZiWeJyq_hAZk2qCZEmk';
const server = http.createServer((q, r) => { (async () => { const t = new URL(q.url, 'http://x').searchParams.get('url'); if (!t) { r.statusCode = 400; return r.end('x'); } const u = await fetch(t, { headers: { accept: '*/*', 'user-agent': 'lifo' } }); r.statusCode = u.status; r.end(Buffer.from(await u.arrayBuffer())); })().catch((e) => { r.statusCode = 502; r.end(e.message); }); });
await new Promise((r) => server.listen(CORS, r));

// server.mjs + supabase/ folder — kept in sync with data/templates/tinbase.ts
const serverMjs = `import { createBackend, createPgmemEngine } from 'tinbase'
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
const dir = path.dirname(fileURLToPath(import.meta.url))
const migrationsDir = path.join(dir, 'supabase', 'migrations')
const seedPath = path.join(dir, 'supabase', 'seed.sql')
const migrations = fs.readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort().map((f) => ({ name: f.replace(/\\.sql$/, ''), sql: fs.readFileSync(path.join(migrationsDir, f), 'utf8') }))
console.log('migrations:', migrations.map((m) => m.name).join(', '))
const engine = await createPgmemEngine()
const backend = await createBackend({ engine, migrations })
if (fs.existsSync(seedPath)) { await engine.exec(fs.readFileSync(seedPath, 'utf8')); console.log('seed applied') }
const server = http.createServer((req, res) => { let body = ''; req.on('data', (c) => { body += c }); req.on('end', async () => { try { const url = 'http://localhost:54321' + req.url; const hasBody = req.method !== 'GET' && req.method !== 'HEAD' && body.length > 0; const request = new Request(url, { method: req.method, headers: req.headers, body: hasBody ? body : undefined }); const response = await backend.fetch(request); const buf = new Uint8Array(await response.arrayBuffer()); const headers = {}; response.headers.forEach((v, k) => { headers[k] = v }); res.writeHead(response.status, headers); res.end(buf) } catch (e) { res.writeHead(500, { 'content-type': 'text/plain' }); res.end('server error: ' + (e && e.message)) } }) })
server.listen(54321, () => console.log('tinbase up on 54321'))
`;

const files = {
  [`${APP}/package.json`]: JSON.stringify({ name: 'tinbase-todo', type: 'module', dependencies: { tinbase: '^0.8.1', 'pg-mem': 'npm:@tinbase/pg-mem@^3.2.0' } }),
  [`${APP}/server.mjs`]: serverMjs,
  [`${APP}/supabase/migrations/20240101000000_create_todos.sql`]: `create table if not exists todos (\n  id bigint generated always as identity primary key,\n  title text not null,\n  done boolean not null default false,\n  created_at timestamptz not null default now()\n);\n`,
  [`${APP}/supabase/seed.sql`]: `insert into todos (title, done) values\n  ('Edit supabase/migrations to change the schema', false),\n  ('Add seed rows in supabase/seed.sql', true);\n`,
};

const sb = await Sandbox.create({ files, cwd: APP, persist: false, env: { LIFO_CORS_PROXY: `http://localhost:${CORS}/_cors?url=` } });
console.log('npm install …');
await sb.commands.run('npm install', { cwd: APP, onStdout: out, onStderr: out, timeout: 300000 });
sb.shell.execute('node server.mjs', { cwd: APP, env: sb.env, onStdout: out, onStderr: out }).catch((e) => console.log('server err:', e.message));
for (let i = 0; i < 40; i++) { if (sb.kernel.portRegistry.has(PORT)) break; await new Promise((r) => setTimeout(r, 300)); }
if (!sb.kernel.portRegistry.has(PORT)) { console.log('backend did not bind'); server.close(); process.exit(2); }
await new Promise((r) => setTimeout(r, 500));

const req = (method, url, body) => new Promise((res) => { const h = sb.kernel.portRegistry.get(PORT); const hdr = { host: `localhost:${PORT}`, apikey: ANON, authorization: 'Bearer ' + ANON, accept: 'application/json' }; if (body) { hdr['content-type'] = 'application/json'; hdr.prefer = 'return=representation'; hdr['content-length'] = String(new TextEncoder().encode(body).length); } const v = { statusCode: 200, headers: {}, body: '' }; h({ method, url, headers: hdr, body: body || '' }, v); v._donePromise ? v._donePromise.then(() => res(v)) : res(v); });
const bodyOf = (v) => (v.bodyBytes ? new TextDecoder().decode(v.bodyBytes) : v.body);

const list = await req('GET', '/rest/v1/todos?select=*&order=id');
const listBody = bodyOf(list);
console.log('\nGET /rest/v1/todos ->', list.statusCode, listBody.slice(0, 300));
const ins = await req('POST', '/rest/v1/todos', JSON.stringify({ title: 'from REST' }));
console.log('POST /rest/v1/todos ->', ins.statusCode, bodyOf(ins).slice(0, 200));

let rows = []; try { rows = JSON.parse(listBody); } catch { /* */ }
const ok = list.statusCode === 200 && Array.isArray(rows) && rows.length === 2 && rows.some((r) => r.title.includes('seed rows')) && (ins.statusCode === 201 || ins.statusCode === 200);
console.log('\n' + (ok ? '✅ PASS — supabase/ folder migrations + seed applied; REST API works' : '❌ FAIL'));
server.close();
process.exit(ok ? 0 : 1);
