/**
 * orchd — run a workload described by an `orchd.json` that travels with the
 * project (inside a snapshot, a tarball, or a container image).
 *
 * ORCHD (github.com/RapidNative/cloud) provisions per-project workloads across
 * substrates: host processes, Docker containers, and Lifo sandboxes. The same
 * `orchd.json` describes all of them, so whatever boots the project can read
 * one file instead of being handed a command line. Inside a Lifo box that is
 * this command.
 *
 * The interesting part is `profiles`: the command a workload runs depends on
 * what is executing it. Real Metro wants `expo start --web`; a Lifo box usually
 * wants `browser-metro`, which bundles via a hosted pre-bundler instead of
 * reading node_modules. One manifest, one override block.
 *
 *   orchd list
 *   orchd resolve --workload mobile --port 8081
 *   orchd run     --workload mobile --port 8081
 */
import type { Command, CommandContext } from '@lifo-sh/core';

const DEFAULT_PROFILE = 'lifo';

export interface OrchdWorkload {
  name: string;
  kind?: string;
  dir?: string;
  install?: string[];
  run?: string[];
  env?: Record<string, string>;
  port_env?: string;
  /** Preferred port. Without one, `up` assigns from --port-base by position. */
  port?: number;
  profiles?: Record<string, Partial<OrchdWorkload>>;
}

export interface OrchdManifest {
  name?: string;
  workloads?: OrchdWorkload[];
}

const USAGE = `orchd — run a workload from orchd.json

Usage:
  orchd list                            list workloads in the manifest
  orchd resolve [options]               print the resolved command line
  orchd run [options]                   resolve, then run it
  orchd up [options]                    start every workload, each on its own port

Options:
  -w, --workload <name>   workload to act on (default: the only one, if unambiguous)
  -p, --port <n>          port to bind; substituted for $PORT (default: $PORT env)
      --profile <name>    profile to merge (default: ${DEFAULT_PROFILE})
  -c, --config <path>     manifest path (default: ./orchd.json, then /orchd.json)
      --all               (resolve) the whole project, not one workload
      --json              (resolve) emit {cwd, argv, env, install} instead of a line
      --port-base <n>     (up/--all) first port to assign (default: 8080)
      --settle <ms>       (up) pause before moving the shell to the next
                          workload's directory (default: 500)
      --no-install        skip the install step even if node_modules is missing
  -h, --help              show this help
`;

/** join two path segments without pulling in a path module. */
function joinPath(base: string, rel?: string): string {
  if (!rel || rel === '.') return base;
  if (rel.startsWith('/')) return rel;
  return (base.endsWith('/') ? base.slice(0, -1) : base) + '/' + rel;
}

function dirOf(path: string): string {
  const i = path.lastIndexOf('/');
  if (i <= 0) return '/';
  return path.slice(0, i);
}

/** Quote an argv entry for a shell line, only when it needs it. */
function shellQuote(arg: string): string {
  if (arg.length > 0 && !/[\s"'$`\\|&;<>()*?[\]{}!#~]/.test(arg)) return arg;
  return `'` + arg.replace(/'/g, `'\\''`) + `'`;
}

/**
 * Merge a profile over a workload. Scalar and array fields replace wholesale
 * (a profile overriding `run` means exactly that); `env` merges key-wise so a
 * profile can add one variable without restating the rest.
 */
export function applyProfile(wl: OrchdWorkload, profile: string): OrchdWorkload {
  const p = wl.profiles?.[profile];
  if (!p) return { ...wl };
  return {
    ...wl,
    ...p,
    name: wl.name,
    env: { ...(wl.env ?? {}), ...(p.env ?? {}) },
    profiles: wl.profiles,
  };
}

/**
 * Substitute $PORT / ${PORT}, and the cross-workload forms ${port:<name>} and
 * ${url:<name>} — which is how one workload learns where another is listening.
 * On a host those are subdomains; in a box everything shares localhost, so the
 * manifest refers to siblings by name and the port is filled in here.
 */
export function expandVars(value: string, vars: Record<string, string>): string {
  return value.replace(/\$\{([\w:]+)\}|\$(\w+)/g, (m, braced, bare) => {
    const key = braced ?? bare;
    return key in vars ? vars[key] : m;
  });
}

export function expandArgv(argv: string[], vars: Record<string, string>): string[] {
  return argv.map((a) => expandVars(a, vars));
}

/** Assign a port to every workload: its declared one, else counting from base. */
export function assignPorts(workloads: OrchdWorkload[], base: number): Record<string, number> {
  const ports: Record<string, number> = {};
  const taken = new Set<number>();
  for (const w of workloads) {
    if (typeof w.port === 'number') { ports[w.name] = w.port; taken.add(w.port); }
  }
  let next = base;
  for (const w of workloads) {
    if (ports[w.name] !== undefined) continue;
    while (taken.has(next)) next++;
    ports[w.name] = next;
    taken.add(next);
    next++;
  }
  return ports;
}

/** The variables visible to one workload: its own $PORT plus every sibling. */
function varsFor(name: string, ports: Record<string, number>): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const [n, p] of Object.entries(ports)) {
    vars[`port:${n}`] = String(p);
    vars[`url:${n}`] = `http://localhost:${p}`;
  }
  if (ports[name] !== undefined) vars.PORT = String(ports[name]);
  return vars;
}

export interface Resolved {
  workload: OrchdWorkload;
  cwd: string;
  argv: string[];
  install?: string[];
  env: Record<string, string>;
}

/** Resolve a manifest + selection into everything needed to run. */
export function resolveWorkload(
  man: OrchdManifest,
  opts: {
    workload?: string; profile?: string; port?: string; configDir: string;
    /** Extra substitutions, e.g. the ${port:<name>} map built by resolveAll. */
    vars?: Record<string, string>;
  },
): Resolved {
  const workloads = man.workloads ?? [];
  if (workloads.length === 0) throw new Error('manifest has no workloads');

  let wl: OrchdWorkload | undefined;
  if (opts.workload) {
    wl = workloads.find((w) => w.name === opts.workload);
    if (!wl) {
      throw new Error(
        `no workload named "${opts.workload}" (have: ${workloads.map((w) => w.name).join(', ')})`,
      );
    }
  } else if (workloads.length === 1) {
    wl = workloads[0];
  } else {
    throw new Error(
      `--workload is required (have: ${workloads.map((w) => w.name).join(', ')})`,
    );
  }

  const merged = applyProfile(wl, opts.profile ?? DEFAULT_PROFILE);
  if (!merged.run || merged.run.length === 0) {
    throw new Error(`workload "${merged.name}" has no run command for this profile`);
  }

  const vars: Record<string, string> = { ...(opts.vars ?? {}) };
  if (opts.port) vars.PORT = opts.port;

  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(merged.env ?? {})) env[k] = expandVars(v, vars);
  // port_env lets a workload receive its port as an env var (e.g. PORT=8081)
  // rather than an argv flag — both styles appear in real manifests.
  const port = opts.port ?? vars.PORT;
  if (port && merged.port_env) env[merged.port_env] = port;

  return {
    workload: merged,
    cwd: joinPath(opts.configDir, merged.dir),
    argv: expandArgv(merged.run, vars),
    install: merged.install ? expandArgv(merged.install, vars) : undefined,
    env,
  };
}

/**
 * Resolve every workload in the manifest, with ports assigned up front so each
 * one can be told where the others are.
 */
export function resolveAll(
  man: OrchdManifest,
  opts: { profile?: string; portBase?: number; configDir: string },
): Resolved[] {
  const workloads = man.workloads ?? [];
  if (workloads.length === 0) throw new Error('manifest has no workloads');
  const ports = assignPorts(workloads, opts.portBase ?? 8080);
  return workloads.map((w) =>
    resolveWorkload(man, {
      workload: w.name,
      profile: opts.profile,
      port: String(ports[w.name]),
      configDir: opts.configDir,
      vars: varsFor(w.name, ports),
    }),
  );
}

/** Render a resolved workload as a shell line, env assignments included. */
export function shellLine(r: Resolved): string {
  const assigns = Object.entries(r.env).map(([k, v]) => `${k}=${shellQuote(v)}`);
  return [...assigns, ...r.argv.map(shellQuote)].join(' ');
}

function parseArgs(args: string[]) {
  const out: {
    cmd?: string; workload?: string; port?: string; profile?: string;
    config?: string; install: boolean; help: boolean; json: boolean;
    all: boolean; portBase?: number; settle?: number;
  } = { install: true, help: false, json: false, all: false };

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    switch (a) {
      case '-h': case '--help': out.help = true; break;
      case '-w': case '--workload': out.workload = args[++i]; break;
      case '-p': case '--port': out.port = args[++i]; break;
      case '--profile': out.profile = args[++i]; break;
      case '-c': case '--config': out.config = args[++i]; break;
      case '--json': out.json = true; break;
      case '--all': out.all = true; break;
      case '--port-base': out.portBase = Number(args[++i]); break;
      case '--settle': out.settle = Number(args[++i]); break;
      case '--no-install': out.install = false; break;
      default:
        if (a.startsWith('-')) throw new Error(`unknown option: ${a}`);
        if (!out.cmd) out.cmd = a;
        break;
    }
  }
  return out;
}

/** Find the manifest: explicit path, then ./orchd.json, then /orchd.json. */
function findManifest(ctx: CommandContext, explicit?: string): string {
  const candidates = explicit
    ? [explicit.startsWith('/') ? explicit : joinPath(ctx.cwd, explicit)]
    : [joinPath(ctx.cwd, 'orchd.json'), '/orchd.json'];
  for (const c of candidates) {
    if (ctx.vfs.exists(c)) return c;
  }
  throw new Error(`no orchd.json found (looked in: ${candidates.join(', ')})`);
}

const orchd: Command = async (ctx: CommandContext): Promise<number> => {
  let opts: ReturnType<typeof parseArgs>;
  try {
    // ctx.args holds the arguments only — the command name is not argv[0].
    opts = parseArgs(ctx.args);
  } catch (e) {
    ctx.stderr.write(`orchd: ${(e as Error).message}\n`);
    return 2;
  }

  if (opts.help || !opts.cmd) {
    ctx.stdout.write(USAGE);
    return opts.help ? 0 : 2;
  }

  let manifestPath: string;
  let man: OrchdManifest;
  try {
    manifestPath = findManifest(ctx, opts.config);
    man = JSON.parse(ctx.vfs.readFileString(manifestPath)) as OrchdManifest;
  } catch (e) {
    ctx.stderr.write(`orchd: ${(e as Error).message}\n`);
    return 1;
  }

  if (opts.cmd === 'list') {
    for (const w of man.workloads ?? []) {
      const profiles = Object.keys(w.profiles ?? {});
      ctx.stdout.write(
        `${w.name}\t${w.kind ?? '-'}\t${w.dir ?? '.'}` +
        (profiles.length ? `\tprofiles: ${profiles.join(',')}` : '') + '\n',
      );
    }
    return 0;
  }

  if (opts.cmd === 'up' || (opts.cmd === 'resolve' && opts.all)) {
    let all: Resolved[];
    try {
      all = resolveAll(man, {
        profile: opts.profile,
        portBase: opts.portBase,
        configDir: dirOf(manifestPath),
      });
    } catch (e) {
      ctx.stderr.write(`orchd: ${(e as Error).message}\n`);
      return 1;
    }

    if (opts.cmd === 'resolve') {
      if (opts.json) {
        ctx.stdout.write(JSON.stringify(all.map((r) => ({
          workload: r.workload.name,
          cwd: r.cwd,
          argv: r.argv,
          env: r.env,
          install: r.install ?? null,
        }))) + '\n');
      } else {
        for (const r of all) ctx.stdout.write(`${r.workload.name}\t${shellLine(r)}\n`);
      }
      return 0;
    }

    // up: start everything at once. Each workload keeps its own cwd and env.
    if (!ctx.executeCapture) {
      ctx.stderr.write(
        'orchd: this shell cannot run nested commands; use `orchd resolve --all` and run the lines\n',
      );
      return 1;
    }

    for (const r of all) {
      const needs = opts.install && r.install && !ctx.vfs.exists(joinPath(r.cwd, 'node_modules'));
      if (!needs) continue;
      const installLine = r.install!.map(shellQuote).join(' ');
      ctx.stdout.write(`orchd: ${r.workload.name}: installing (${installLine})\n`);
      try {
        await ctx.executeCapture(installLine, { cwd: r.cwd });
      } catch (e) {
        ctx.stderr.write(`orchd: ${r.workload.name}: install failed: ${(e as Error).message}\n`);
        return 1;
      }
    }

    // Start each workload as a BACKGROUND job. A shell runs one foreground
    // command at a time and a dev server never exits, so foregrounding would
    // boot only the first workload. Backgrounding also returns you to the
    // prompt with everything running (`jobs` lists them).
    //
    // The `cd` matters: passing executeCapture a {cwd} does not survive
    // backgrounding, because the job resolves its paths when it STARTS, by
    // which time the capture has already restored the previous directory — the
    // job then fails with ENOENT. For the same reason we let a job settle
    // before the next `cd` moves the shell out from under it.
    const settle = opts.settle ?? 500;
    let prevCwd: string | null = null;
    for (let i = 0; i < all.length; i++) {
      const r = all[i];
      const line = shellLine(r);
      ctx.stdout.write(`orchd: ${r.workload.name} -> ${line} (cwd ${r.cwd})\n`);
      try {
        await ctx.executeCapture(`cd ${shellQuote(r.cwd)} && ${line} &`);
      } catch (e) {
        ctx.stderr.write(`orchd: ${r.workload.name}: ${(e as Error).message}\n`);
        return 1;
      }
      // Only pay the settle delay when the next job would move the shell.
      const nextCwd = all[i + 1]?.cwd;
      if (nextCwd !== undefined && nextCwd !== r.cwd && settle > 0) {
        await new Promise((res) => setTimeout(res, settle));
      }
      prevCwd = r.cwd;
    }
    // Leave the shell where it started rather than inside the last workload.
    if (prevCwd !== null && prevCwd !== ctx.cwd) {
      if (settle > 0) await new Promise((res) => setTimeout(res, settle));
      try {
        await ctx.executeCapture(`cd ${shellQuote(ctx.cwd)}`);
      } catch { /* cosmetic only */ }
    }
    ctx.stdout.write(`orchd: ${all.length} workload(s) started; \`jobs\` to list them\n`);
    return 0;
  }

  if (opts.cmd !== 'resolve' && opts.cmd !== 'run') {
    ctx.stderr.write(`orchd: unknown command "${opts.cmd}"\n\n${USAGE}`);
    return 2;
  }

  let r: Resolved;
  try {
    r = resolveWorkload(man, {
      workload: opts.workload,
      profile: opts.profile,
      port: opts.port ?? ctx.env.PORT,
      configDir: dirOf(manifestPath),
    });
  } catch (e) {
    ctx.stderr.write(`orchd: ${(e as Error).message}\n`);
    return 1;
  }

  const line = shellLine(r);

  if (opts.cmd === 'resolve') {
    // --json is the machine interface: a host driver needs the working
    // directory and env too, not just the command line.
    if (opts.json) {
      ctx.stdout.write(JSON.stringify({
        workload: r.workload.name,
        cwd: r.cwd,
        argv: r.argv,
        env: r.env,
        install: r.install ?? null,
      }) + '\n');
      return 0;
    }
    ctx.stdout.write(line + '\n');
    return 0;
  }

  // run
  if (!ctx.executeCapture) {
    ctx.stderr.write(
      'orchd: this shell cannot run nested commands; use `orchd resolve` and run the printed line\n',
    );
    return 1;
  }

  const needsInstall =
    opts.install && r.install && !ctx.vfs.exists(joinPath(r.cwd, 'node_modules'));
  if (needsInstall) {
    const installLine = r.install!.map(shellQuote).join(' ');
    ctx.stdout.write(`orchd: installing (${installLine})\n`);
    try {
      await ctx.executeCapture(installLine, { cwd: r.cwd });
    } catch (e) {
      ctx.stderr.write(`orchd: install failed: ${(e as Error).message}\n`);
      return 1;
    }
  }

  ctx.stdout.write(`orchd: ${r.workload.name} -> ${line} (cwd ${r.cwd})\n`);

  // NOTE: executeCapture buffers stdout/stderr and takes no AbortSignal, so a
  // long-running server started here produces no output until it exits and is
  // not torn down when this command is aborted. That is fine for one-shot
  // workloads; for a dev server prefer `orchd resolve` and let the host run the
  // line with its own streaming + signal (that is what the ORCHD Lifo driver
  // does). Kept here because it makes the command usable interactively.
  try {
    const res = await ctx.executeCapture(line, { cwd: r.cwd });
    if (res) ctx.stdout.write(res);
    return 0;
  } catch (e) {
    ctx.stderr.write(`orchd: ${(e as Error).message}\n`);
    return 1;
  }
};

export default orchd;
