import { describe, it, expect } from 'vitest';
import { VFS } from '@lifo-sh/core';
import type { CommandContext, CommandOutputStream } from '@lifo-sh/core';
import orchd from '../src/lifo.js';
import { applyProfile, assignPorts, expandArgv, resolveAll, resolveWorkload } from '../src/manifest.js';

const MANIFEST = {
  name: 'rapidnative',
  workloads: [
    { name: 'db', kind: 'tinbase', profiles: { lifo: { run: ['npx', 'tinbase', '--engine', 'pgmem'] } } },
    {
      name: 'api', kind: 'node', dir: 'api',
      install: ['npm', 'install'],
      run: ['node', '--watch', 'index.js'],
      port_env: 'PORT',
    },
    {
      name: 'mobile', kind: 'node', dir: 'mobile',
      install: ['npm', 'install'],
      run: ['npx', 'expo', 'start', '--web', '--port', '$PORT'],
      env: { CI: '1' },
      profiles: {
        lifo: { run: ['browser-metro', '--port', '$PORT'], env: { BROWSER: 'none' } },
      },
    },
  ],
};

function ctxFor(args: string[], opts: { cwd?: string; files?: Record<string, string>; exec?: (input: string, o?: { cwd?: string }) => Promise<string> } = {}) {
  const vfs = new VFS();
  const files = opts.files ?? { '/proj/orchd.json': JSON.stringify(MANIFEST) };
  for (const [p, c] of Object.entries(files)) {
    const dir = p.slice(0, p.lastIndexOf('/'));
    if (dir) vfs.mkdir(dir, { recursive: true });
    vfs.writeFile(p, c);
  }
  const stdout = { text: '', write(t: string) { this.text += t; } };
  const stderr = { text: '', write(t: string) { this.text += t; } };
  const calls: { input: string; cwd?: string }[] = [];
  const ctx = {
    args,
    env: { HOME: '/home/user' },
    cwd: opts.cwd ?? '/proj',
    vfs,
    stdout: stdout as CommandOutputStream & { text: string },
    stderr: stderr as CommandOutputStream & { text: string },
    signal: new AbortController().signal,
    executeCapture: opts.exec ?? (async (input: string, o?: { cwd?: string }) => { calls.push({ input, cwd: o?.cwd }); return ''; }),
  } as unknown as CommandContext & { stdout: { text: string }; stderr: { text: string } };
  return { ctx, calls, vfs };
}

describe('cross-workload wiring', () => {
  const WIRED = {
    workloads: [
      { name: 'db', kind: 'tinbase', port: 5432, run: ['tinbase', 'start', '--port', '$PORT'] },
      {
        name: 'app', kind: 'node', dir: 'app', run: ['vite', '--port', '$PORT'],
        env: { API_URL: '${url:db}', DB_PORT: '${port:db}' },
      },
    ],
  };

  it('assigns declared ports first, then fills from the base', () => {
    expect(assignPorts(WIRED.workloads, 8080)).toEqual({ db: 5432, app: 8080 });
  });

  it('never reuses a declared port when filling', () => {
    const wls = [{ name: 'a', port: 8080 }, { name: 'b' }, { name: 'c' }];
    expect(assignPorts(wls, 8080)).toEqual({ a: 8080, b: 8081, c: 8082 });
  });

  it('resolves ${url:x} and ${port:x} to a sibling\'s assigned port', () => {
    const all = resolveAll(WIRED, { configDir: '/p', portBase: 8080 });
    const app = all.find((r) => r.workload.name === 'app')!;
    expect(app.env.API_URL).toBe('http://localhost:5432');
    expect(app.env.DB_PORT).toBe('5432');
    expect(app.argv).toEqual(['vite', '--port', '8080']);
  });
});

describe('resolution', () => {
  it('merges a profile over the base workload', () => {
    const wl = MANIFEST.workloads[2];
    const merged = applyProfile(wl, 'lifo');
    expect(merged.run).toEqual(['browser-metro', '--port', '$PORT']);
    // env merges key-wise rather than replacing
    expect(merged.env).toEqual({ CI: '1', BROWSER: 'none' });
    expect(merged.name).toBe('mobile');
  });

  it('leaves the base untouched when the profile is absent', () => {
    const merged = applyProfile(MANIFEST.workloads[1], 'lifo');
    expect(merged.run).toEqual(['node', '--watch', 'index.js']);
  });

  it('expands $PORT and ${PORT}', () => {
    expect(expandArgv(['a', '$PORT', '${PORT}', '$OTHER'], { PORT: '8081' }))
      .toEqual(['a', '8081', '8081', '$OTHER']);
  });

  it('resolves cwd from the manifest directory plus dir', () => {
    const r = resolveWorkload(MANIFEST, { workload: 'mobile', port: '8081', configDir: '/proj', profile: 'lifo' });
    expect(r.cwd).toBe('/proj/mobile');
    expect(r.argv).toEqual(['browser-metro', '--port', '8081']);
  });

  // The pure layer applies NO profile of its own — the runner chooses one. This
  // is what lets the same package run a project's ordinary commands on a host
  // (`npx orchd up`) while a box still gets browser-metro.
  it('applies no profile unless the caller asks for one', () => {
    const r = resolveWorkload(MANIFEST, { workload: 'mobile', port: '8081', configDir: '/proj' });
    expect(r.argv).toEqual(['npx', 'expo', 'start', '--web', '--port', '8081']);
    expect(r.env.BROWSER).toBeUndefined();
  });

  it('the in-box command still defaults to the lifo profile', async () => {
    const { ctx } = ctxFor(['resolve', '--workload', 'mobile', '--port', '8081']);
    expect(await orchd(ctx)).toBe(0);
    expect(ctx.stdout.text).toContain('browser-metro');
  });

  it('passes the port via port_env when the workload asks for it', () => {
    const r = resolveWorkload(MANIFEST, { workload: 'api', port: '9000', configDir: '/proj' });
    expect(r.env.PORT).toBe('9000');
  });

  it('requires --workload when the manifest is ambiguous', () => {
    expect(() => resolveWorkload(MANIFEST, { configDir: '/proj' })).toThrow(/--workload is required/);
  });

  it('defaults to the only workload when unambiguous', () => {
    const one = { workloads: [{ name: 'solo', run: ['echo', 'hi'] }] };
    expect(resolveWorkload(one, { configDir: '/' }).workload.name).toBe('solo');
  });

  it('names the available workloads when one is not found', () => {
    expect(() => resolveWorkload(MANIFEST, { workload: 'nope', configDir: '/proj' }))
      .toThrow(/have: db, api, mobile/);
  });
});

describe('command', () => {
  it('lists workloads', async () => {
    const { ctx } = ctxFor(['list']);
    expect(await orchd(ctx)).toBe(0);
    expect(ctx.stdout.text).toContain('mobile');
    expect(ctx.stdout.text).toContain('profiles: lifo');
  });

  it('resolve prints the command line without running anything', async () => {
    const { ctx, calls } = ctxFor(['resolve', '--workload', 'mobile', '--port', '8081']);
    expect(await orchd(ctx)).toBe(0);
    // env travels with the line as prefix assignments — executeCapture has no env option
    expect(ctx.stdout.text.trim()).toBe('CI=1 BROWSER=none browser-metro --port 8081');
    expect(calls).toHaveLength(0);
  });

  it('honours --profile', async () => {
    const { ctx } = ctxFor(['resolve', '--workload', 'mobile', '--port', '8081', '--profile', 'docker']);
    expect(await orchd(ctx)).toBe(0);
    expect(ctx.stdout.text.trim()).toBe('CI=1 npx expo start --web --port 8081');
  });

  it('takes the port from $PORT when not passed', async () => {
    const { ctx } = ctxFor(['resolve', '--workload', 'mobile']);
    ctx.env.PORT = '7777';
    expect(await orchd(ctx)).toBe(0);
    expect(ctx.stdout.text.trim()).toBe('CI=1 BROWSER=none browser-metro --port 7777');
  });

  it('run executes in the workload directory', async () => {
    const { ctx, calls } = ctxFor(['run', '--workload', 'mobile', '--port', '8081', '--no-install']);
    expect(await orchd(ctx)).toBe(0);
    expect(calls.at(-1)).toEqual({ input: 'CI=1 BROWSER=none browser-metro --port 8081', cwd: '/proj/mobile' });
  });

  it('installs first when node_modules is missing', async () => {
    const { ctx, calls } = ctxFor(['run', '--workload', 'api', '--port', '9000']);
    expect(await orchd(ctx)).toBe(0);
    expect(calls.map((c) => c.input)).toEqual(['npm install', 'PORT=9000 node --watch index.js']);
  });

  it('skips install with --no-install', async () => {
    const { ctx, calls } = ctxFor(['run', '--workload', 'api', '--port', '9000', '--no-install']);
    expect(await orchd(ctx)).toBe(0);
    expect(calls.map((c) => c.input)).toEqual(['PORT=9000 node --watch index.js']);
  });

  it('falls back to /orchd.json when the cwd has none', async () => {
    const { ctx } = ctxFor(['resolve', '--workload', 'mobile', '--port', '1'], {
      cwd: '/somewhere', files: { '/orchd.json': JSON.stringify(MANIFEST) },
    });
    expect(await orchd(ctx)).toBe(0);
    expect(ctx.stdout.text.trim()).toBe('CI=1 BROWSER=none browser-metro --port 1');
  });

  it('errors clearly when no manifest exists', async () => {
    const { ctx } = ctxFor(['list'], { cwd: '/empty', files: {} });
    expect(await orchd(ctx)).toBe(1);
    expect(ctx.stderr.text).toContain('no orchd.json found');
  });

  it('rejects unknown options and commands', async () => {
    const { ctx } = ctxFor(['resolve', '--bogus']);
    expect(await orchd(ctx)).toBe(2);
    expect(ctx.stderr.text).toContain('unknown option');

    const b = ctxFor(['frobnicate']);
    expect(await orchd(b.ctx)).toBe(2);
    expect(b.ctx.stderr.text).toContain('unknown command');
  });

  it('prints usage with --help', async () => {
    const { ctx } = ctxFor(['--help']);
    expect(await orchd(ctx)).toBe(0);
    expect(ctx.stdout.text).toContain('orchd resolve');
  });

  it('resolve --json emits cwd, argv and env for a host driver', async () => {
    const { ctx } = ctxFor(['resolve', '--workload', 'mobile', '--port', '8081', '--json']);
    expect(await orchd(ctx)).toBe(0);
    expect(JSON.parse(ctx.stdout.text)).toEqual({
      workload: 'mobile',
      cwd: '/proj/mobile',
      argv: ['browser-metro', '--port', '8081'],
      env: { CI: '1', BROWSER: 'none' },
      install: ['npm', 'install'],
    });
  });

  it('resolve --all assigns a port per workload from the base', async () => {
    const { ctx } = ctxFor(['resolve', '--all', '--port-base', '8080']);
    expect(await orchd(ctx)).toBe(0);
    const lines = ctx.stdout.text.trim().split('\n');
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain('db');
    expect(lines[1]).toContain('PORT=8081');          // api, via port_env
    expect(lines[2]).toContain('--port 8082');         // mobile, via $PORT
  });

  it('resolve --all --json emits the whole plan', async () => {
    const { ctx } = ctxFor(['resolve', '--all', '--json']);
    expect(await orchd(ctx)).toBe(0);
    const plan = JSON.parse(ctx.stdout.text);
    expect(plan.map((p: { workload: string }) => p.workload)).toEqual(['db', 'api', 'mobile']);
    expect(plan[2].cwd).toBe('/proj/mobile');
  });

  it('up starts every workload as a background job', async () => {
    const { ctx, calls } = ctxFor(['up', '--no-install', '--port-base', '9000', '--settle', '0']);
    expect(await orchd(ctx)).toBe(0);
    const launches = calls.filter((c) => c.input.endsWith(' &'));
    expect(launches).toHaveLength(3);
    // Each job cds itself: a {cwd} option does not survive backgrounding,
    // because the job resolves paths when it starts — after the restore.
    expect(launches[2].input).toBe('cd /proj/mobile && CI=1 BROWSER=none browser-metro --port 9002 &');
    expect(ctx.stdout.text).toContain('3 workload(s) started');
  });

  it('up returns the shell to where it started', async () => {
    const { ctx, calls } = ctxFor(['up', '--no-install', '--settle', '0']);
    expect(await orchd(ctx)).toBe(0);
    expect(calls.at(-1)!.input).toBe('cd /proj');
  });

  it('quotes arguments that need it', async () => {
    const man = { workloads: [{ name: 'x', run: ['sh', '-c', 'echo hi && echo bye'] }] };
    const { ctx } = ctxFor(['resolve'], { files: { '/proj/orchd.json': JSON.stringify(man) } });
    expect(await orchd(ctx)).toBe(0);
    expect(ctx.stdout.text.trim()).toBe("sh -c 'echo hi && echo bye'");
  });
});
