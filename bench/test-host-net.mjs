#!/usr/bin/env node
/**
 * test-host-net.mjs — the host-side network API against a REAL in-VM tinbase,
 * with no service worker anywhere.
 *
 * Covers the whole scenario the SW-free Supabase examples need:
 *
 *   1. sandbox.waitForPort + sandbox.fetch reach tinbase's REST API (the new
 *      public API — no MessagePort adapter, no requestId correlation).
 *   2. sandbox.fetch pulls the tinbase STUDIO document at /_/ — a self-contained
 *      single-file HTML, which is what makes it mountable in a blob: iframe.
 *      Note '/' is a JSON health check, so the entry path matters.
 *   3. supabase-js, unmodified, talks to tinbase through sandbox.fetch.
 *   4. The nosw iframe transport routes to the RIGHT PORT: the real
 *      resolveTarget from @lifo-sh/ui's shim maps an Expo app's
 *      `/_sw/54321/...` URL to port 54321, and the parent bridge answers it —
 *      an app on 8081 reaching its backend on 54321 with no code change.
 *
 * Run: node bench/test-host-net.mjs
 */
import { Sandbox, ServiceWorkerBridge } from '../packages/core/dist/index.js';
import { resolveVmTarget } from '../packages/ui/dist/vm-routing.js';

const PORT = 54321;
const APP = '/home/user/tinbase-app';
const out = (s) => process.stdout.write(s);
const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
}

// ── boot a box with a real supabase/ project ────────────────────────────────
const files = {
  [`${APP}/package.json`]: JSON.stringify({
    name: 'tinbase-app',
    private: true,
    devDependencies: { tinbase: '^0.10.1', 'pg-mem': 'npm:@tinbase/pg-mem@^3.2.0' },
    dependencies: { '@supabase/supabase-js': '^2.110.0' },
  }, null, 2),
  [`${APP}/supabase/migrations/20240101000000_create_todos.sql`]: `create table if not exists todos (
  id bigint generated always as identity primary key,
  title text not null,
  done boolean not null default false,
  created_at timestamptz not null default now()
);
`,
  [`${APP}/supabase/seed.sql`]: `insert into todos (title, done) values
  ('from seed one', false),
  ('from seed two', true);
`,
};

const ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InRpbmJhc2UiLCJyb2xlIjoiYW5vbiIsImlhdCI6MTc4MzI3MzU0OSwiZXhwIjoyMDk4NjMzNTQ5fQ.yaaSYTyy2tRkx1myq06zU1ieZiWeJyq_hAZk2qCZEmk';

console.log('booting box + installing tinbase…');
const sb = await Sandbox.create({ files, cwd: APP, persist: false });
const install = await sb.commands.run('npm install 2>&1 | tail -2', { cwd: APP, timeout: 600000 });
if (install.exitCode !== 0) { console.log('npm install failed:', install.stdout, install.stderr); process.exit(2); }

sb.shell.execute('npx tinbase --engine pgmem', { cwd: APP, env: sb.env, onStdout: () => {}, onStderr: () => {} }).catch(() => {});

// ── 1. waitForPort + sandbox.fetch ─────────────────────────────────────────
try {
  await sb.waitForPort(PORT, { timeout: 120000 });
  check('sandbox.waitForPort resolves once tinbase binds 54321', true);
} catch (e) {
  check('sandbox.waitForPort resolves once tinbase binds 54321', false, e.message);
  process.exit(2);
}

const auth = { apikey: ANON, authorization: `Bearer ${ANON}` };

const sel = await sb.fetch(`http://localhost:${PORT}/rest/v1/todos?select=*&order=id`, { headers: auth });
const rows = sel.ok ? await sel.json() : null;
check('sandbox.fetch GET /rest/v1/todos returns the seeded rows',
  sel.status === 200 && Array.isArray(rows) && rows.length === 2,
  `status ${sel.status}, ${rows ? rows.length : '?'} rows`);

const ins = await sb.fetch(`http://localhost:${PORT}/rest/v1/todos`, {
  method: 'POST',
  headers: { ...auth, 'content-type': 'application/json', prefer: 'return=representation' },
  body: JSON.stringify({ title: 'from sandbox.fetch' }),
});
const insBody = await ins.text();
check('sandbox.fetch POST inserts a row', ins.status === 201, `status ${ins.status} ${insBody.slice(0, 60)}`);

// ── 2. the studio document ─────────────────────────────────────────────────
const root = await sb.fetch(`http://localhost:${PORT}/`);
const rootType = root.headers.get('content-type') || '';
check("'/' is a JSON health check, not the app (so entry path matters)",
  rootType.includes('application/json'), rootType);

const studio = await sb.fetch(`http://localhost:${PORT}/_/`);
const html = await studio.text();
const externalScripts = (html.match(/<script[^>]+src=/gi) || []).length;
const externalCss = (html.match(/<link[^>]+stylesheet/gi) || []).length;
check('sandbox.fetch GET /_/ returns the studio HTML', studio.status === 200 && html.startsWith('<!doctype html'), `status ${studio.status}, ${html.length}b`);
check('studio is self-contained (no external script/css to resolve in a blob doc)',
  externalScripts === 0 && externalCss === 0, `${externalScripts} scripts, ${externalCss} stylesheets`);

// ── 3. unmodified supabase-js, driven through sandbox.fetch ────────────────
// supabase-js accepts a custom fetch; pointing it at sandbox.fetch is exactly
// what the iframe shim does for app code, minus the postMessage hop.
const { createClient } = await import('@supabase/supabase-js').catch(() => ({ createClient: null }));

if (createClient) {
  const supabase = createClient(`http://localhost:${PORT}`, ANON, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: (url, init) => sb.fetch(String(url), init) },
  });
  const { data, error } = await supabase.from('todos').select('*').order('id');
  check('unmodified supabase-js works over sandbox.fetch',
    !error && Array.isArray(data) && data.length >= 2,
    error ? error.message : `${data?.length} rows`);
} else {
  console.log('skip  supabase-js not resolvable from the host — covered in-VM by the examples');
}

// ── 4. the nosw iframe transport, multi-port ───────────────────────────────
// Build the parent half exactly as mountNoSwPreview does: ServiceWorkerBridge
// with a postMessage adapter. Then drive it with URLs run through the REAL
// resolveTarget lifted from the shim the iframe receives.
const responses = [];
const adapter = { onmessage: null, postMessage: (m) => responses.push(m), start() {}, close() {} };
const bridge = new ServiceWorkerBridge(sb.kernel.portRegistry);
bridge.attach(adapter);

const PREVIEW_PORT = 8081; // where Metro would be — deliberately NOT tinbase
const HOST_ORIGIN = 'http://localhost:5173'; // the embedding page, excluded from in-VM routing

// The exact function the shim inlines into the iframe, imported directly.
const resolveTarget = (url) => resolveVmTarget(url, PREVIEW_PORT, HOST_ORIGIN);

let seq = 0;
async function shimFetch(url, { method = 'GET', headers = {}, body } = {}) {
  const target = resolveTarget(url);
  if (!target) return { skipped: true };
  const id = `r${seq++}`;
  const b64 = body ? Buffer.from(body, 'utf8').toString('base64') : '';
  adapter.onmessage({ data: { type: 'request', requestId: id, port: target.port, method, url: target.path, headers, body: b64 } });
  for (let i = 0; i < 200; i++) {
    const r = responses.find((m) => m.type === 'response' && m.requestId === id);
    if (r) {
      const buf = r.bodyBuffer ? Buffer.from(r.bodyBuffer) : Buffer.from(r.body || '', 'base64');
      return { status: r.statusCode, text: buf.toString('utf8'), target };
    }
    await new Promise((res) => setTimeout(res, 50));
  }
  return { status: 0, text: 'timeout', target };
}

// This is the app's UNCHANGED .env value: EXPO_PUBLIC_SUPABASE_URL=/_sw/54321
const viaSwPath = await shimFetch('/_sw/54321/rest/v1/todos?select=*&order=id', { headers: auth });
check('iframe shim routes /_sw/54321/… to port 54321 (app code unchanged)',
  viaSwPath.target?.port === 54321 && viaSwPath.status === 200 && viaSwPath.text.includes('from seed one'),
  `port ${viaSwPath.target?.port}, status ${viaSwPath.status}`);

const viaAbsolute = await shimFetch(`http://localhost:${PORT}/rest/v1/todos?select=title`, { headers: auth });
check('iframe shim routes an absolute loopback URL to its own port',
  viaAbsolute.target?.port === 54321 && viaAbsolute.status === 200,
  `port ${viaAbsolute.target?.port}, status ${viaAbsolute.status}`);

const studioViaShim = await shimFetch('/_sw/54321/_/');
check('iframe shim can load the studio document at /_/ on the sibling port',
  studioViaShim.status === 200 && studioViaShim.text.startsWith('<!doctype html'),
  `status ${studioViaShim.status}, ${studioViaShim.text.length}b`);

// A preview-relative asset must still go to the PREVIEW port, not the backend.
const previewRelative = resolveTarget('/index.bundle?platform=web');
check('preview-relative URLs still go to the preview port',
  previewRelative.port === PREVIEW_PORT, `port ${previewRelative.port}`);

// The embedding page's own origin must NOT be tunnelled into the VM.
check('the embedding page’s origin is not tunnelled',
  resolveTarget('http://localhost:5173/_cors?url=https://x.dev') === null);

// ── report ────────────────────────────────────────────────────────────────
const failed = results.filter((r) => !r.ok);
console.log('');
console.log(failed.length === 0
  ? `PASS — ${results.length} checks: sandbox.fetch + multi-port nosw transport against a real in-VM tinbase (no service worker)`
  : `FAIL — ${failed.length}/${results.length} failed: ${failed.map((f) => f.name).join('; ')}`);
try { bridge.destroy(); } catch { /* ignore */ }
sb.destroy();
process.exit(failed.length === 0 ? 0 : 1);
