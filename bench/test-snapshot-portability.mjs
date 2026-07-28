#!/usr/bin/env node
/**
 * test-snapshot-portability.mjs — one snapshot format, every environment.
 *
 * Saves a snapshot through the REAL CLI (daemon + Unix socket + `lifo snapshot
 * save`) and restores that exact file into a plain `@lifo-sh/core` box — the same
 * code path the browser playground uses. Then does the reverse.
 *
 * This is the property the format exists for. Before the manifest, the CLI wrote
 * a zip wrapping a JSON-serialized VFS while core wrote a tar.gz of files, so
 * neither could read the other's snapshots.
 *
 * Run: node bench/test-snapshot-portability.mjs
 */
import { spawn, execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as net from 'node:net';
import { Sandbox, readSnapshotMetadata } from '../packages/core/dist/index.js';

const CLI = path.join(process.cwd(), 'packages/cli/dist/index.js');
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
};

const sessionId = 'snapport';
const sessionsDir = path.join(os.homedir(), '.lifo', 'sessions');
const sockPath = path.join(sessionsDir, `${sessionId}.sock`);
const hostDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lifo-snapport-'));
const outFile = path.join(os.tmpdir(), `snapport-${Date.now()}.tar.gz`);

/** Type a line into the live session over the daemon socket. */
function sendInput(line) {
  return new Promise((resolve, reject) => {
    const c = net.connect(sockPath, () => {
      c.write(JSON.stringify({ type: 'input', data: line + '\r' }) + '\n');
      setTimeout(() => { c.end(); resolve(); }, 1500);
    });
    c.on('error', reject);
  });
}

console.log('booting a CLI session…');
const daemon = spawn('node', [CLI, '--daemon', '--id', sessionId, '--mount', hostDir], {
  stdio: ['ignore', 'ignore', 'pipe'],
});
let daemonErr = '';
daemon.stderr.on('data', (d) => { daemonErr += String(d); });

// Wait for the session socket to appear.
for (let i = 0; i < 60; i++) {
  if (fs.existsSync(sockPath)) break;
  await new Promise((r) => setTimeout(r, 250));
}
if (!fs.existsSync(sockPath)) {
  console.log('daemon never came up:\n' + daemonErr.slice(-500));
  process.exit(2);
}

// Create state INSIDE the CLI box: a file, a cwd and an env var.
await sendInput('mkdir -p /home/user/from-cli');
await sendInput('echo "written in the CLI" > /home/user/from-cli/note.txt');
await sendInput('cd /home/user/from-cli');
await sendInput('export FROM_CLI=yes');
await new Promise((r) => setTimeout(r, 1000));

console.log('saving a snapshot through the CLI…');
try {
  execFileSync('node', [CLI, 'snapshot', 'save', sessionId, '--output', outFile], { stdio: 'pipe' });
} catch (e) {
  console.log('snapshot save failed:', String(e.stdout || '') + String(e.stderr || ''));
  process.exit(2);
}
check('lifo snapshot save writes an archive', fs.existsSync(outFile), `${fs.statSync(outFile).size} bytes`);

const bytes = new Uint8Array(fs.readFileSync(outFile));
check('the file is gzip (tar.gz), not a zip', bytes[0] === 0x1f && bytes[1] === 0x8b);

const manifest = await readSnapshotMetadata(bytes);
check('it carries a manifest with cwd + env',
  manifest?.cwd === '/home/user/from-cli' && manifest?.env?.FROM_CLI === 'yes',
  `cwd=${manifest?.cwd} FROM_CLI=${manifest?.env?.FROM_CLI}`);
check('the manifest records the host mount path', typeof manifest?.mountPath === 'string', manifest?.mountPath);

// ── the actual point: restore the CLI's file into a core box ────────────────
console.log('restoring that same file into a @lifo-sh/core box…');
const box = await Sandbox.create({ persist: false });
const restored = await box.importSnapshot(bytes);

check('a CLI snapshot restores into a core/browser box',
  (await box.fs.readFile('/home/user/from-cli/note.txt')).trim() === 'written in the CLI');
check('cwd from the CLI session is applied', box.cwd === '/home/user/from-cli', box.cwd);
check('env from the CLI session is applied', box.env.FROM_CLI === 'yes');
check('importSnapshot returns the manifest', restored?.version === 1);
check('the manifest is not restored as a VFS file', !(await box.fs.exists('/lifo-snapshot.json')));

// ── and the reverse: a core snapshot the CLI can read ──────────────────────
console.log('exporting from core and reading it back the way the CLI does…');
await box.fs.writeFile('/home/user/from-core.txt', 'written in core');
box.cwd = '/home/user';
const coreBytes = await box.exportSnapshot();
const coreManifest = await readSnapshotMetadata(coreBytes);
check('a core snapshot carries the same manifest shape',
  coreManifest?.version === 1 && coreManifest?.cwd === '/home/user',
  `cwd=${coreManifest?.cwd}`);

const roundTrip = await Sandbox.create({ persist: false });
await roundTrip.importSnapshot(coreBytes);
check('core → core round trip keeps both files',
  (await roundTrip.fs.exists('/home/user/from-core.txt')) &&
  (await roundTrip.fs.exists('/home/user/from-cli/note.txt')));

// ── cleanup ───────────────────────────────────────────────────────────────
box.destroy();
roundTrip.destroy();
try { execFileSync('node', [CLI, 'stop', sessionId], { stdio: 'ignore' }); } catch { /* already gone */ }
try { daemon.kill(); } catch { /* ok */ }
for (const p of [outFile]) { try { fs.unlinkSync(p); } catch { /* ok */ } }
try { fs.rmSync(hostDir, { recursive: true, force: true }); } catch { /* ok */ }
for (const ext of ['.json', '.sock', '.log']) { try { fs.unlinkSync(path.join(sessionsDir, sessionId + ext)); } catch { /* ok */ } }

const failed = results.filter((r) => !r.ok);
console.log('');
console.log(failed.length === 0
  ? `PASS — ${results.length} checks: one snapshot format across the CLI and core/browser`
  : `FAIL — ${failed.length}/${results.length}: ${failed.map((f) => f.name).join('; ')}`);
process.exit(failed.length === 0 ? 0 : 1);
