#!/usr/bin/env node
/**
 * test-express-bridge.mjs — exercise the exact host path the SW / nosw preview
 * uses: a POST with a base64 body + restored Content-Length flows through
 * ServiceWorkerBridge.handleRequest into the in-VM Express server, and
 * express.json parses it. This is what was broken in the browser (the SW dropped
 * Content-Length, so express.json skipped parsing → "text is required").
 */
import http from 'node:http';
import { Sandbox, ServiceWorkerBridge } from '../packages/core/dist/index.js';

const CORS = 8822, PORT = 3000, APP = '/home/user/express-app';
const out = (s) => process.stdout.write(s);
const server = http.createServer((q, r) => { (async () => { const t = new URL(q.url, 'http://x').searchParams.get('url'); if (!t) { r.statusCode = 400; return r.end('x'); } const u = await fetch(t, { headers: { accept: '*/*', 'user-agent': 'lifo' } }); r.statusCode = u.status; r.end(Buffer.from(await u.arrayBuffer())); })().catch((e) => { r.statusCode = 502; r.end(e.message); }); });
await new Promise((r) => server.listen(CORS, r));

const files = {
  [`${APP}/package.json`]: JSON.stringify({ name: 'express-app', dependencies: { express: '^4.21.2' } }),
  [`${APP}/server.js`]: `const express=require('express');const app=express();app.use(express.json());
let todos=[];let n=1;
app.get('/api/todos',(req,res)=>res.json(todos));
app.post('/api/todos',(req,res)=>{const text=(req.body&&req.body.text||'').trim();if(!text)return res.status(400).json({error:'text is required'});const t={id:n++,text};todos.push(t);res.status(201).json(t);});
app.listen(${PORT},()=>console.log('up on ${PORT}'));`,
};

const sb = await Sandbox.create({ files, cwd: APP, persist: false, env: { LIFO_CORS_PROXY: `http://localhost:${CORS}/_cors?url=` } });
await sb.commands.run('npm install', { cwd: APP, onStdout: out, onStderr: out, timeout: 300000 });
sb.shell.execute('node server.js', { cwd: APP, env: sb.env, onStdout: out, onStderr: out }).catch(() => {});
for (let i = 0; i < 40; i++) { if (sb.kernel.portRegistry.has(PORT)) break; await new Promise((r) => setTimeout(r, 300)); }
if (!sb.kernel.portRegistry.has(PORT)) { console.log('port never bound'); server.close(); process.exit(2); }

// Simulate the SW/host transport via ServiceWorkerBridge.
const responses = [];
const adapter = { onmessage: null, postMessage: (m) => responses.push(m), start() {}, close() {} };
const bridge = new ServiceWorkerBridge(sb.kernel.portRegistry);
bridge.attach(adapter);

function send(msg) { adapter.onmessage({ data: msg }); }
function b64(str) { return Buffer.from(str, 'utf8').toString('base64'); }
async function waitResp(id) { for (let i = 0; i < 60; i++) { const r = responses.find((m) => m.type === 'response' && m.requestId === id); if (r) return r; await new Promise((r) => setTimeout(r, 50)); } return null; }
const decode = (r) => { const b = r.bodyBuffer ? Buffer.from(r.bodyBuffer) : Buffer.from(r.body || '', 'base64'); return b.toString('utf8'); };

// POST WITHOUT content-length (the OLD broken behavior) → express.json skips.
const jsonNoCL = JSON.stringify({ text: 'no content-length' });
send({ type: 'request', requestId: 'a', port: PORT, method: 'POST', url: '/api/todos', headers: { 'content-type': 'application/json' }, body: b64(jsonNoCL) });
const rA = await waitResp('a');
console.log('\n[no content-length]  ->', rA && rA.statusCode, rA && decode(rA));

// POST WITH content-length (what the SW/nosw shims now send) → parses.
const jsonCL = JSON.stringify({ text: 'with content-length' });
send({ type: 'request', requestId: 'b', port: PORT, method: 'POST', url: '/api/todos', headers: { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(jsonCL, 'utf8')) }, body: b64(jsonCL) });
const rB = await waitResp('b');
console.log('[with content-length]->', rB && rB.statusCode, rB && decode(rB));

const ok = rB && rB.statusCode === 201 && decode(rB).includes('with content-length');
console.log('\n' + (ok ? '✅ PASS — restored Content-Length makes express.json parse the POST body over the bridge' : '❌ FAIL'));
server.close();
process.exit(ok ? 0 : 1);
