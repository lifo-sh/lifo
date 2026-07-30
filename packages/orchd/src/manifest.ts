/**
 * orchd — run a workload described by an `orchd.json` that travels with the
 * project (inside a snapshot, a tarball, or a container image).
 *
 * ORCHD (github.com/RapidNative/cloud) provisions per-project workloads across
 * substrates: host processes, Docker containers, and Lifo sandboxes. The same
 * `orchd.json` describes all of them, so whatever boots the project can read
 * one file instead of being handed a command line.
 *
 * This module is the PURE layer: manifest types, profile merging, port
 * assignment, variable expansion and resolution. It imports nothing — no node,
 * no lifo — so both runners sit on top of the same semantics:
 *
 *   src/cli.ts    the `orchd` bin: real child processes on a host
 *   src/lifo.ts   the in-box command: jobs in a Lifo shell
 *
 * The interesting part is `profiles`: the command a workload runs depends on
 * what is executing it. On a host `npm run dev` is right; a Lifo box usually
 * wants `browser-metro`, which bundles via a hosted pre-bundler instead of
 * reading node_modules. One manifest, one override block — and note that no
 * profile is applied unless a runner asks for one, so the plain `run` is what
 * you get outside a box.
 */
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

export const USAGE = `orchd — run a workload from orchd.json

Usage:
  orchd list                            list workloads in the manifest
  orchd resolve [options]               print the resolved command line
  orchd run [options]                   resolve, then run it
  orchd up [options]                    start every workload, each on its own port

Options:
  -w, --workload <name>   workload to act on (default: the only one, if unambiguous)
  -p, --port <n>          port to bind; substituted for $PORT (default: $PORT env)
      --profile <name>    profile to merge (default: none on a host, lifo in a box)
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
export function joinPath(base: string, rel?: string): string {
  if (!rel || rel === '.') return base;
  if (rel.startsWith('/')) return rel;
  return (base.endsWith('/') ? base.slice(0, -1) : base) + '/' + rel;
}

export function dirOf(path: string): string {
  const i = path.lastIndexOf('/');
  if (i <= 0) return '/';
  return path.slice(0, i);
}

/** Quote an argv entry for a shell line, only when it needs it. */
export function shellQuote(arg: string): string {
  if (arg.length > 0 && !/[\s"'$`\\|&;<>()*?[\]{}!#~]/.test(arg)) return arg;
  return `'` + arg.replace(/'/g, `'\\''`) + `'`;
}

/**
 * Merge a profile over a workload. Scalar and array fields replace wholesale
 * (a profile overriding `run` means exactly that); `env` merges key-wise so a
 * profile can add one variable without restating the rest.
 */
export function applyProfile(wl: OrchdWorkload, profile?: string): OrchdWorkload {
  const p = profile ? wl.profiles?.[profile] : undefined;
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

  const merged = applyProfile(wl, opts.profile);
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

export function parseArgs(args: string[]) {
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
