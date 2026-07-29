/**
 * The host bin, exercised as a real process.
 *
 * These spawn `dist/cli.js` rather than importing it, because everything worth
 * testing here IS the process behaviour: real children, real ports, the
 * foreground supervision contract, and SIGINT teardown. Requires a build.
 */
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const CLI = resolve(__dirname, '../dist/cli.js');

/** A workload that binds its port and reports which one it got. */
const SERVER = (label: string) => `const http = require('http');
const port = Number(process.env.PORT || 0);
http.createServer((_q, s) => {
  s.writeHead(200, { 'content-type': 'application/json' });
  s.end(JSON.stringify({ workload: '${label}', port }));
}).listen(port, () => console.log('${label} listening on ' + port));
`;

function project(manifest: unknown, files: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'orchd-'));
  writeFileSync(join(dir, 'orchd.json'), JSON.stringify(manifest, null, 2));
  for (const [rel, body] of Object.entries(files)) {
    const full = join(dir, rel);
    mkdirSync(resolve(full, '..'), { recursive: true });
    writeFileSync(full, body);
  }
  return dir;
}

/** Run the bin to completion and capture it. */
function run(args: string[], cwd: string): { code: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync(process.execPath, [CLI, ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { code: 0, stdout, stderr: '' };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { code: err.status ?? 1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
}

const TWO_SERVERS = {
  name: 'e2e',
  workloads: [
    { name: 'api', kind: 'node', dir: 'api', port: 3000, run: ['node', 'index.js'], port_env: 'PORT' },
    {
      name: 'web', kind: 'node', dir: 'web', port: 3001, run: ['node', 'index.js'], port_env: 'PORT',
      env: { API_URL: '${url:api}' },
      // Present so we can prove a host does NOT pick it up.
      profiles: { lifo: { run: ['browser-metro', '.'] } },
    },
  ],
};
const SERVER_FILES = { 'api/index.js': SERVER('api'), 'web/index.js': SERVER('web') };

let running: ChildProcess | null = null;
afterEach(() => {
  if (running && running.exitCode === null) running.kill('SIGKILL');
  running = null;
});

describe('orchd bin', () => {
  beforeAll(() => {
    if (!existsSync(CLI)) throw new Error(`build first: ${CLI} missing`);
  });

  it('lists workloads', () => {
    const dir = project(TWO_SERVERS);
    const { code, stdout } = run(['list'], dir);
    expect(code).toBe(0);
    expect(stdout).toContain('api');
    expect(stdout).toContain('web');
    rmSync(dir, { recursive: true, force: true });
  });

  it('resolves a host command line with no profile applied', () => {
    const dir = project(TWO_SERVERS);
    const { code, stdout } = run(['resolve', '-w', 'web', '--json'], dir);
    expect(code).toBe(0);
    const r = JSON.parse(stdout);
    // The lifo profile exists in the manifest and must NOT leak onto a host.
    expect(r.argv).toEqual(['node', 'index.js']);
    expect(r.argv).not.toContain('browser-metro');
    rmSync(dir, { recursive: true, force: true });
  });

  it('applies a profile when asked for one explicitly', () => {
    const dir = project(TWO_SERVERS);
    const { stdout } = run(['resolve', '-w', 'web', '--profile', 'lifo', '--json'], dir);
    expect(JSON.parse(stdout).argv).toEqual(['browser-metro', '.']);
    rmSync(dir, { recursive: true, force: true });
  });

  it('wires ${url:api} to the sibling workload port', () => {
    const dir = project(TWO_SERVERS);
    const { stdout } = run(['resolve', '--all', '--json'], dir);
    const web = JSON.parse(stdout).find((r: { workload: string }) => r.workload === 'web');
    expect(web.env.API_URL).toBe('http://localhost:3000');
    rmSync(dir, { recursive: true, force: true });
  });

  it('finds the manifest from a subdirectory', () => {
    const dir = project(TWO_SERVERS, SERVER_FILES);
    const { code, stdout } = run(['list'], join(dir, 'api'));
    expect(code).toBe(0);
    expect(stdout).toContain('api');
    rmSync(dir, { recursive: true, force: true });
  });

  it('exits 2 with usage when given no subcommand', () => {
    const dir = project(TWO_SERVERS);
    const { code, stdout } = run([], dir);
    expect(code).toBe(2);
    expect(stdout).toContain('Usage:');
    rmSync(dir, { recursive: true, force: true });
  });

  it('reports a missing manifest instead of crashing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orchd-empty-'));
    const { code, stderr } = run(['list'], dir);
    expect(code).toBe(1);
    expect(stderr).toContain('no orchd.json found');
    rmSync(dir, { recursive: true, force: true });
  });

  // The real thing: `up` boots both workloads on their own ports, keeps them in
  // the foreground under prefixed output, and Ctrl-C brings the set down.
  it('up starts every workload, serves on each port, and tears down on SIGINT', async () => {
    const dir = project(TWO_SERVERS, SERVER_FILES);
    const child = spawn(process.execPath, [CLI, 'up', '--no-install'], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });
    running = child;
    let out = '';
    child.stdout.on('data', (b) => { out += b.toString(); });
    child.stderr.on('data', (b) => { out += b.toString(); });

    const fetchJson = async (port: number) => {
      const deadline = Date.now() + 20_000;
      for (;;) {
        try {
          const res = await fetch(`http://127.0.0.1:${port}/`);
          return await res.json() as { workload: string; port: number };
        } catch (e) {
          if (Date.now() > deadline) throw e;
          await new Promise((r) => setTimeout(r, 150));
        }
      }
    };

    expect(await fetchJson(3000)).toEqual({ workload: 'api', port: 3000 });
    expect(await fetchJson(3001)).toEqual({ workload: 'web', port: 3001 });
    // Output carries a per-workload prefix, the way `docker compose up` does.
    expect(out).toMatch(/api\s*\|/);

    const exited = new Promise<number | null>((res) => child.on('exit', (code) => res(code)));
    child.kill('SIGINT');
    await exited;
    // Both children are gone with the supervisor: nothing still holds the ports.
    await expect(fetch('http://127.0.0.1:3000/').catch(() => 'refused')).resolves.toBe('refused');
  }, 40_000);

  it('up stops the whole set when one workload exits', async () => {
    const dir = project(
      {
        workloads: [
          { name: 'ok', kind: 'node', dir: 'ok', port: 3010, run: ['node', 'index.js'], port_env: 'PORT' },
          { name: 'bad', kind: 'node', dir: 'bad', run: ['node', 'index.js'] },
        ],
      },
      { 'ok/index.js': SERVER('ok'), 'bad/index.js': 'process.exit(3);\n' },
    );
    const child = spawn(process.execPath, [CLI, 'up', '--no-install'], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });
    running = child;
    let out = '';
    child.stderr.on('data', (b) => { out += b.toString(); });
    const code = await new Promise<number | null>((res) => child.on('exit', (c) => res(c)));
    expect(code).toBe(3);
    expect(out).toContain('stopping the rest');
    rmSync(dir, { recursive: true, force: true });
  }, 40_000);
});
