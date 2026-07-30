/**
 * The host runner: the `orchd` bin, for `npx orchd up` or a global install.
 *
 * Same manifest, same resolution (./manifest.ts) as the in-box command — the
 * difference is only in what "run" means. Here workloads are real child
 * processes; in a box they are shell jobs.
 *
 * Two deliberate differences from the box:
 *
 *  - No profile is applied unless you pass --profile. A host runs a project's
 *    ordinary commands (`npm run dev`, `expo start --web`); `profiles.lifo` is
 *    for a box and must not leak out of one.
 *  - `up` supervises in the FOREGROUND, the way `docker compose up` does:
 *    output is interleaved with a per-workload prefix, and Ctrl-C tears the
 *    whole set down. A box backgrounds them instead, because there you want the
 *    prompt back.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve as resolvePath } from 'node:path';
import {
  USAGE, parseArgs, resolveAll, resolveWorkload, shellLine,
  type OrchdManifest, type Resolved,
} from './manifest.js';

/** Find the manifest: explicit path, then ./orchd.json, then upwards. */
function findManifest(cwd: string, explicit?: string): string {
  if (explicit) {
    const p = isAbsolute(explicit) ? explicit : resolvePath(cwd, explicit);
    if (existsSync(p)) return p;
    throw new Error(`no manifest at ${p}`);
  }
  // Walking up means `orchd up` works from a subdirectory of the project, which
  // is what you expect from git/npm and cannot be done inside a box's VFS root.
  let dir = cwd;
  for (;;) {
    const candidate = resolvePath(dir, 'orchd.json');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`no orchd.json found in ${cwd} or any parent directory`);
}

/** Colour the prefix only for a TTY — piped output stays grep-able. */
const COLOURS = [36, 32, 35, 33, 34, 31];
function prefixer(name: string, width: number, index: number): string {
  const padded = name.padEnd(width);
  return process.stdout.isTTY ? `\x1b[${COLOURS[index % COLOURS.length]}m${padded} |\x1b[0m ` : `${padded} | `;
}

/** Stream a child's output line-by-line under its workload's prefix. */
function pipePrefixed(child: ChildProcess, prefix: string): void {
  for (const [stream, sink] of [
    [child.stdout, process.stdout],
    [child.stderr, process.stderr],
  ] as const) {
    let buffered = '';
    stream?.on('data', (chunk: Buffer) => {
      buffered += chunk.toString();
      const lines = buffered.split('\n');
      // Hold the trailing partial line so a prefix never lands mid-line.
      buffered = lines.pop() ?? '';
      for (const line of lines) sink.write(prefix + line + '\n');
    });
    stream?.on('end', () => {
      if (buffered) sink.write(prefix + buffered + '\n');
    });
  }
}

function spawnWorkload(r: Resolved, opts: { prefix?: string; group?: boolean } = {}): ChildProcess {
  const [cmd, ...args] = r.argv;
  const child = spawn(cmd, args, {
    cwd: r.cwd,
    env: { ...process.env, ...r.env },
    stdio: opts.prefix ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    // No shell: argv is already an array, and going through a shell would make
    // quoting the caller's problem and orphan the process group on teardown.
    shell: false,
    // `up` gives each workload its own process group so teardown can signal the
    // whole tree. A real `run` is usually a launcher — `npm run dev` execs npm,
    // which spawns the server as a GRANDCHILD — and child.kill() would reap only
    // npm, orphaning the server still holding the port. Interactive Ctrl-C hides
    // this (the tty signals the foreground group), but our own teardown paths do
    // not. See killTree.
    //
    // Not used for `run`, where stdio is inherited: a detached child sits outside
    // the terminal's foreground group and gets SIGTTIN the moment it reads stdin,
    // which would break interactive dev servers.
    detached: opts.group === true,
  });
  if (opts.prefix) pipePrefixed(child, opts.prefix);
  return child;
}

/** Signal a workload's whole process group, falling back to the child alone. */
function killTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  try {
    // Negative pid = the process group created by detached: true.
    if (child.pid !== undefined) process.kill(-child.pid, signal);
  } catch {
    // ESRCH (already gone) or EPERM — the direct kill is the best remaining try.
    child.kill(signal);
  }
}

function runToCompletion(r: Resolved, argv: string[], label: string): Promise<void> {
  const [cmd, ...args] = argv;
  return new Promise((res, rej) => {
    const child = spawn(cmd, args, { cwd: r.cwd, env: { ...process.env, ...r.env }, stdio: 'inherit', shell: false });
    child.on('error', rej);
    child.on('exit', (code) =>
      code === 0 ? res() : rej(new Error(`${label} exited ${code}`)));
  });
}

async function installIfNeeded(all: Resolved[], enabled: boolean): Promise<void> {
  for (const r of all) {
    if (!enabled || !r.install) continue;
    if (existsSync(resolvePath(r.cwd, 'node_modules'))) continue;
    process.stderr.write(`orchd: ${r.workload.name}: installing (${r.install.join(' ')})\n`);
    await runToCompletion(r, r.install, `${r.workload.name} install`);
  }
}

/** Start every workload and stay in the foreground until one dies or we're signalled. */
async function up(all: Resolved[]): Promise<number> {
  const width = Math.max(...all.map((r) => r.workload.name.length));
  const children = new Map<string, ChildProcess>();
  let shuttingDown = false;
  let exitCode = 0;

  const teardown = (signal: NodeJS.Signals = 'SIGTERM') => {
    if (shuttingDown) return;
    shuttingDown = true;
    for (const child of children.values()) killTree(child, signal);
  };
  process.on('SIGINT', () => { process.stderr.write('\norchd: stopping…\n'); teardown('SIGINT'); });
  process.on('SIGTERM', () => teardown('SIGTERM'));

  const exits: Promise<void>[] = [];
  all.forEach((r, i) => {
    process.stderr.write(`orchd: ${r.workload.name} -> ${shellLine(r)} (cwd ${r.cwd})\n`);
    const child = spawnWorkload(r, { prefix: prefixer(r.workload.name, width, i), group: true });
    children.set(r.workload.name, child);
    exits.push(new Promise<void>((res) => {
      child.on('error', (e) => {
        process.stderr.write(`orchd: ${r.workload.name}: ${e.message}\n`);
        exitCode ||= 1;
        // One workload failing to even start makes the set meaningless — bring
        // the rest down rather than leaving a half-booted project running.
        teardown();
        res();
      });
      child.on('exit', (code, signal) => {
        if (!shuttingDown) {
          process.stderr.write(`orchd: ${r.workload.name} exited (${signal ?? code}) — stopping the rest\n`);
          exitCode ||= code ?? 1;
          teardown();
        }
        res();
      });
    }));
  });

  await Promise.all(exits);
  return exitCode;
}

export async function main(argv: string[]): Promise<number> {
  let opts: ReturnType<typeof parseArgs>;
  try {
    opts = parseArgs(argv);
  } catch (e) {
    process.stderr.write(`orchd: ${(e as Error).message}\n`);
    return 2;
  }

  if (opts.help || !opts.cmd) {
    process.stdout.write(USAGE);
    return opts.help ? 0 : 2;
  }

  let manifestPath: string;
  let man: OrchdManifest;
  try {
    manifestPath = findManifest(process.cwd(), opts.config);
    man = JSON.parse(readFileSync(manifestPath, 'utf8')) as OrchdManifest;
  } catch (e) {
    process.stderr.write(`orchd: ${(e as Error).message}\n`);
    return 1;
  }
  const configDir = dirname(manifestPath);

  if (opts.cmd === 'list') {
    for (const w of man.workloads ?? []) {
      const profiles = Object.keys(w.profiles ?? {});
      process.stdout.write(
        `${w.name}\t${w.kind ?? '-'}\t${w.dir ?? '.'}` +
        (profiles.length ? `\tprofiles: ${profiles.join(',')}` : '') + '\n',
      );
    }
    return 0;
  }

  const asJson = (r: Resolved) => JSON.stringify({
    workload: r.workload.name, cwd: r.cwd, argv: r.argv, env: r.env, install: r.install ?? null,
  });

  try {
    if (opts.cmd === 'up' || (opts.cmd === 'resolve' && opts.all)) {
      const all = resolveAll(man, { profile: opts.profile, portBase: opts.portBase, configDir });
      if (opts.cmd === 'resolve') {
        process.stdout.write(opts.json
          ? JSON.stringify(all.map((r) => JSON.parse(asJson(r)))) + '\n'
          : all.map((r) => `${r.workload.name}\t${shellLine(r)}`).join('\n') + '\n');
        return 0;
      }
      await installIfNeeded(all, opts.install);
      return await up(all);
    }

    if (opts.cmd !== 'resolve' && opts.cmd !== 'run') {
      process.stderr.write(`orchd: unknown command "${opts.cmd}"\n\n${USAGE}`);
      return 2;
    }

    const r = resolveWorkload(man, {
      workload: opts.workload, profile: opts.profile,
      port: opts.port ?? process.env.PORT, configDir,
    });

    if (opts.cmd === 'resolve') {
      process.stdout.write((opts.json ? asJson(r) : shellLine(r)) + '\n');
      return 0;
    }

    await installIfNeeded([r], opts.install);
    process.stderr.write(`orchd: ${r.workload.name} -> ${shellLine(r)} (cwd ${r.cwd})\n`);
    // A single workload gets the terminal itself: inherited stdio, so an
    // interactive dev server (Metro's key handling, a prompt) behaves normally.
    const child = spawnWorkload(r);
    process.on('SIGINT', () => child.kill('SIGINT'));
    process.on('SIGTERM', () => child.kill('SIGTERM'));
    return await new Promise<number>((res, rej) => {
      child.on('error', rej);
      child.on('exit', (code, signal) => res(signal ? 1 : code ?? 0));
    });
  } catch (e) {
    process.stderr.write(`orchd: ${(e as Error).message}\n`);
    return 1;
  }
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (e: Error) => { process.stderr.write(`orchd: ${e.message}\n`); process.exit(1); },
);
