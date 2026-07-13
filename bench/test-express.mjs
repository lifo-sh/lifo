#!/usr/bin/env node
/**
 * test-express.mjs — end-to-end check of the Node.js + Express example: install
 * express, run the server, and exercise the JSON API (GET/POST/toggle/DELETE)
 * plus static file serving — all in the VM's Node compat layer.
 */
import http from 'node:http';
import { Sandbox } from '../packages/core/dist/index.js';

const CORS = 8820, PORT = 3000, APP = '/home/user/express-app';
const out = (s) => process.stdout.write(s);
const server = http.createServer((q, r) => { (async () => { const t = new URL(q.url, 'http://x').searchParams.get('url'); if (!t) { r.statusCode = 400; return r.end('x'); } const u = await fetch(t, { headers: { accept: '*/*', 'user-agent': 'lifo' } }); r.statusCode = u.status; r.end(Buffer.from(await u.arrayBuffer())); })().catch((e) => { r.statusCode = 502; r.end(e.message); }); });
await new Promise((r) => server.listen(CORS, r));

const files = {
  [`${APP}/package.json`]: JSON.stringify({ name: 'express-app', version: '1.0.0', private: true, scripts: { start: 'node server.js' }, dependencies: { express: '^4.21.2' } }, null, 2),
  [`${APP}/server.js`]: `const express = require('express');
const path = require('path');
const app = express();
app.use(express.json());
let todos = [{ id: 1, text: 'first', done: false }];
let nextId = 2;
app.get('/api/todos', (req, res) => res.json(todos));
app.post('/api/todos', (req, res) => { const text = (req.body && req.body.text || '').trim(); if (!text) return res.status(400).json({ error: 'text required' }); const t = { id: nextId++, text, done: false }; todos.push(t); res.status(201).json(t); });
app.post('/api/todos/:id/toggle', (req, res) => { const t = todos.find((x) => x.id === Number(req.params.id)); if (!t) return res.status(404).json({ error: 'nf' }); t.done = !t.done; res.json(t); });
app.delete('/api/todos/:id', (req, res) => { todos = todos.filter((x) => x.id !== Number(req.params.id)); res.status(204).end(); });
app.use(express.static(path.join(__dirname, 'public')));
app.listen(process.env.PORT || 3000, () => console.log('Express on :3000'));
`,
  [`${APP}/public/index.html`]: `<!DOCTYPE html><html><head><title>Express Todos · Lifo</title></head><body><h1>Express Todos</h1></body></html>`,
};

const sb = await Sandbox.create({ files, cwd: APP, persist: false, env: { LIFO_CORS_PROXY: `http://localhost:${CORS}/_cors?url=` } });
console.log('npm install express …');
await sb.commands.run('npm install', { cwd: APP, onStdout: out, onStderr: out, timeout: 300000 });
console.log('\nexpress installed?', sb.kernel.vfs.exists(`${APP}/node_modules/express/package.json`));

sb.shell.execute('node server.js', { cwd: APP, env: sb.env, onStdout: out, onStderr: out }).catch((e) => console.log('server err:', e.message));
let bound = false;
for (let i = 0; i < 40; i++) { if (sb.kernel.portRegistry.has(PORT)) { bound = true; break; } await new Promise((r) => setTimeout(r, 300)); }
console.log('\nport', PORT, 'bound:', bound);
if (!bound) { server.close(); process.exit(2); }

const req = (method, url, body) => new Promise((res) => { const h = sb.kernel.portRegistry.get(PORT); const hdr = { host: `localhost:${PORT}` }; if (body) { hdr['content-type'] = 'application/json'; hdr['content-length'] = String(new TextEncoder().encode(body).length); } const v = { statusCode: 200, headers: {}, body: '' }; h({ method, url, headers: hdr, body: body || '' }, v); v._donePromise ? v._donePromise.then(() => res(v)) : res(v); });
const bodyOf = (v) => (v.bodyBytes ? new TextDecoder().decode(v.bodyBytes) : v.body);

const page = await req('GET', '/');
const post = await req('POST', '/api/todos', JSON.stringify({ text: 'from POST' }));
const toggle = await req('POST', '/api/todos/1/toggle');
const del = await req('DELETE', '/api/todos/1');
const list = await req('GET', '/api/todos');
const listBody = bodyOf(list);

console.log('\nGET /            ->', page.statusCode, bodyOf(page).includes('Express Todos') ? '(static page OK)' : '(NO page)');
console.log('POST /api/todos  ->', post.statusCode, bodyOf(post));
console.log('POST …/1/toggle  ->', toggle.statusCode, bodyOf(toggle));
console.log('DELETE …/1       ->', del.statusCode);
console.log('GET /api/todos   ->', list.statusCode, listBody);

const ok = page.statusCode === 200 && bodyOf(page).includes('Express Todos')
  && post.statusCode === 201 && bodyOf(post).includes('from POST')
  && toggle.statusCode === 200
  && del.statusCode === 204
  && list.statusCode === 200 && listBody.includes('from POST') && !listBody.includes('"id":1');
console.log('\n' + (ok ? '✅ PASS — Express example: API (GET/POST/toggle/DELETE) + static all work in the VM' : '❌ FAIL'));
server.close();
process.exit(ok ? 0 : 1);
