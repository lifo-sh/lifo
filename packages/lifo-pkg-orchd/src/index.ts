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

Options:
  -w, --workload <name>   workload to act on (default: the only one, if unambiguous)
  -p, --port <n>          port to bind; substituted for $PORT (default: $PORT env)
      --profile <name>    profile to merge (default: ${DEFAULT_PROFILE})
  -c, --config <path>     manifest path (default: ./orchd.json, then /orchd.json)
      --json              (resolve) emit {cwd, argv, env, install} instead of a line
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

/** Substitute $PORT / ${PORT} (and any other provided var) in an argv. */
export function expandArgv(argv: string[], vars: Record<string, string>): string[] {
  return argv.map((a) =>
    a.replace(/\$\{(\w+)\}|\$(\w+)/g, (m, braced, bare) => {
      const key = braced ?? bare;
      return key in vars ? vars[key] : m;
    }),
  );
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
  opts: { workload?: string; profile?: string; port?: string; configDir: string },
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

  const vars: Record<string, string> = {};
  if (opts.port) vars.PORT = opts.port;

  const env: Record<string, string> = { ...(merged.env ?? {}) };
  // port_env lets a workload receive its port as an env var (e.g. PORT=8081)
  // rather than an argv flag — both styles appear in real manifests.
  if (opts.port && merged.port_env) env[merged.port_env] = opts.port;

  return {
    workload: merged,
    cwd: joinPath(opts.configDir, merged.dir),
    argv: expandArgv(merged.run, vars),
    install: merged.install ? expandArgv(merged.install, vars) : undefined,
    env,
  };
}

function parseArgs(args: string[]) {
  const out: {
    cmd?: string; workload?: string; port?: string; profile?: string;
    config?: string; install: boolean; help: boolean; json: boolean;
  } = { install: true, help: false, json: false };

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    switch (a) {
      case '-h': case '--help': out.help = true; break;
      case '-w': case '--workload': out.workload = args[++i]; break;
      case '-p': case '--port': out.port = args[++i]; break;
      case '--profile': out.profile = args[++i]; break;
      case '-c': case '--config': out.config = args[++i]; break;
      case '--json': out.json = true; break;
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

  const line = r.argv.map(shellQuote).join(' ');

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
