/**
 * The in-box runner: `orchd` as a Lifo command.
 *
 * Registered via the `lifo.commands` field in package.json, which lifo's
 * package runtime keys on by manifest field rather than package name — so the
 * same npm package that gives a host the `orchd` bin also gives a box the
 * command. All manifest semantics live in ./manifest.ts; this file only bridges
 * them to a CommandContext (its VFS, its streams, its shell).
 *
 * Profile: `lifo` by default here, which is the whole point of profiles — a box
 * gets browser-metro where a host gets Metro.
 */
import type { Command, CommandContext } from '@lifo-sh/core';
import {
  USAGE, dirOf, joinPath, parseArgs, resolveAll, resolveWorkload, shellLine, shellQuote,
  type OrchdManifest, type Resolved,
} from './manifest.js';

const DEFAULT_PROFILE = 'lifo';

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
        profile: opts.profile ?? DEFAULT_PROFILE,
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
      profile: opts.profile ?? DEFAULT_PROFILE,
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
