/**
 * test-orchd-up.mjs — actually run `orchd up` inside a real Lifo box.
 *
 * The package's own 28 tests drive a mocked shell context, so they prove `up`
 * ISSUES the right commands but never that workloads come up. This boots a box,
 * registers the command the way the playground does, and asserts both declared
 * ports end up bound — using sandbox.waitForPort.
 *
 * Run: node bench/test-orchd-up.mjs
 */
import { Sandbox } from '../packages/core/dist/index.js';
import orchdCommand from '../packages/orchd/dist/lifo.js';

const APP = '/home/user/proj';
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
};

const manifest = {
  name: 'e2e',
  workloads: [
    { name: 'api', kind: 'node', dir: 'api', port: 3000, run: ['node', 'index.js'], port_env: 'PORT' },
    { name: 'web', kind: 'node', dir: 'web', port: 3001, run: ['node', 'index.js'], port_env: 'PORT' },
  ],
};

const server = (label) => `const http = require('http');
const port = Number(process.env.PORT || 0);
http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ workload: '${label}', port }));
}).listen(port, () => console.log('${label} listening on ' + port));
`;

const sb = await Sandbox.create({
  persist: false,
  cwd: APP,
  files: {
    [`${APP}/orchd.json`]: JSON.stringify(manifest, null, 2) + '\n',
    [`${APP}/api/index.js`]: server('api'),
    [`${APP}/web/index.js`]: server('web'),
  },
});
sb.commands.register('orchd', orchdCommand);

// ── list ────────────────────────────────────────────────────────────────────
const list = await sb.commands.run('orchd list', { cwd: APP });
check('orchd list finds both workloads',
  list.exitCode === 0 && /api/.test(list.stdout) && /web/.test(list.stdout),
  `exit ${list.exitCode}`);

// ── resolve ─────────────────────────────────────────────────────────────────
const resolve = await sb.commands.run('orchd resolve -w api --port 3000 --no-install', { cwd: APP });
check('orchd resolve prints a command line for a workload',
  resolve.exitCode === 0 && /node/.test(resolve.stdout) && /index\.js/.test(resolve.stdout),
  resolve.stdout.trim().slice(0, 80));

// ── bare orchd ──────────────────────────────────────────────────────────────
const bare = await sb.commands.run('orchd', { cwd: APP });
check('bare `orchd` prints usage and exits 2 (documented behaviour)',
  bare.exitCode === 2 && /Usage:/.test(bare.stdout + bare.stderr),
  `exit ${bare.exitCode}`);

// ── up: the real thing ──────────────────────────────────────────────────────
console.log('\nrunning `orchd up` …');
sb.shell.execute('orchd up --no-install --port-base 3000 --settle 200', {
  cwd: APP,
  env: sb.env,
  onStdout: (t) => process.stdout.write(t),
  onStderr: (t) => process.stderr.write(t),
}).catch((e) => console.log('up threw:', e.message));

let apiUp = false, webUp = false;
try { await sb.waitForPort(3000, { timeout: 45_000 }); apiUp = true; } catch { /* reported below */ }
try { await sb.waitForPort(3001, { timeout: 45_000 }); webUp = true; } catch { /* reported below */ }

check('orchd up bound the first workload (3000)', apiUp);
check('orchd up bound the second workload (3001)', webUp);

if (apiUp) {
  const res = await sb.fetch('http://localhost:3000/');
  const body = res.ok ? await res.json() : null;
  check('the api workload actually serves', body?.workload === 'api' && body?.port === 3000, JSON.stringify(body));
}
if (webUp) {
  const res = await sb.fetch('http://localhost:3001/');
  const body = res.ok ? await res.json() : null;
  check('the web workload actually serves, on its own port', body?.workload === 'web' && body?.port === 3001, JSON.stringify(body));
}

const failed = results.filter((r) => !r.ok);
console.log('');
console.log(failed.length === 0
  ? `PASS — ${results.length} checks: orchd up boots every workload in a real box`
  : `FAIL — ${failed.length}/${results.length}: ${failed.map((f) => f.name).join('; ')}`);
sb.destroy();
process.exit(failed.length === 0 ? 0 : 1);
