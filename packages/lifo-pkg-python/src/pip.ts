/**
 * `pip` / `pip3` for Lifo, backed by micropip: installs pure-Python wheels from PyPI and packages
 * Pyodide builds, into the box's Python (they last as long as the box's page or process).
 *
 *   pip install requests rich      pip install -r requirements.txt
 *   pip list                       pip uninstall -y rich
 */

import type { CommandContext } from '@lifo-sh/core';
import { bindIO, getPython, unbindIO, withPython } from './runtime.js';

const USAGE = `Usage:
  pip install [-r requirements.txt] <package> ...
  pip uninstall [-y] <package> ...
  pip list
  pip --version
Installs pure-Python wheels from PyPI and packages Pyodide builds (micropip). Packages with
native code that Pyodide doesn't build can't be installed.
`;

function readRequirements(ctx: CommandContext, file: string): string[] {
  const path = file.startsWith('/') ? file : `${ctx.cwd}/${file}`;
  return ctx.vfs
    .readFileString(path)
    .split('\n')
    .map((l) => l.replace(/#.*/, '').trim())
    .filter((l) => l && !l.startsWith('-'));
}

export async function pipMain(ctx: CommandContext, args: string[]): Promise<number> {
  const sub = args[0];
  if (!sub || sub === '-h' || sub === '--help' || sub === 'help') {
    ctx.stdout.write(USAGE);
    return sub ? 0 : 1;
  }
  const box = await getPython(ctx);
  const py = box.py;
  if (sub === '-V' || sub === '--version') {
    const v = String(py.runPython('import sys; sys.version.split()[0]'));
    ctx.stdout.write(`pip (micropip, Pyodide ${py.version}) for Python ${v}\n`);
    return 0;
  }
  const rest = args.slice(1);
  // -v / --verbose (or PIP_VERBOSE=1): the package loader's own messages and full tracebacks.
  const verbose = rest.includes('-v') || rest.includes('--verbose') || !!ctx.env.PIP_VERBOSE;
  const say = verbose ? (m: string) => void ctx.stderr.write(`${m}\n`) : () => {};
  return withPython(box, async () => {
    bindIO(box, ctx, '', null);
    try {
      await py.loadPackage('micropip', { messageCallback: say, errorCallback: say });
      if (sub === 'install') {
        const pkgs: string[] = [];
        for (let i = 0; i < rest.length; i++) {
          const a = rest[i];
          if (a === '-r' || a === '--requirement') pkgs.push(...readRequirements(ctx, rest[++i] ?? ''));
          else if (!a.startsWith('-')) pkgs.push(a);
        }
        if (pkgs.length === 0) {
          ctx.stderr.write('ERROR: You must give at least one requirement to install\n');
          return 1;
        }
        ctx.stdout.write(`Collecting ${pkgs.join(', ')}\n`);
        py.globals.set('_lifo_pkgs', py.toPy(pkgs));
        const added = (await py.runPythonAsync(`
import micropip
_before = {p.name: p.version for p in micropip.list().values()}
await micropip.install(_lifo_pkgs, keep_going=True)
_after = {p.name: p.version for p in micropip.list().values()}
' '.join(f"{n}-{v}" for n, v in sorted(_after.items()) if _before.get(n) != v)
`)) as string;
        ctx.stdout.write(added ? `Successfully installed ${added}\n` : 'Requirement already satisfied\n');
        return 0;
      }
      if (sub === 'list' || sub === 'freeze') {
        const rows = (await py.runPythonAsync(`
import micropip
sorted((p.name, p.version) for p in micropip.list().values())
`)) as { toJs(): [string, string][] };
        const list = rows.toJs();
        if (sub === 'freeze') {
          for (const [n, v] of list) ctx.stdout.write(`${n}==${v}\n`);
        } else {
          const w = Math.max(7, ...list.map(([n]) => n.length));
          ctx.stdout.write(`${'Package'.padEnd(w)} Version\n${'-'.repeat(w)} -------\n`);
          for (const [n, v] of list) ctx.stdout.write(`${n.padEnd(w)} ${v}\n`);
        }
        return 0;
      }
      if (sub === 'uninstall') {
        const pkgs = rest.filter((a) => !a.startsWith('-'));
        py.globals.set('_lifo_pkgs', py.toPy(pkgs));
        await py.runPythonAsync('import micropip; micropip.uninstall(_lifo_pkgs)');
        for (const p of pkgs) ctx.stdout.write(`Successfully uninstalled ${p}\n`);
        return 0;
      }
      ctx.stderr.write(`ERROR: unknown command "${sub}"\n${USAGE}`);
      return 1;
    } catch (e) {
      const msg = (e as Error).message;
      // Python errors carry the whole traceback; the last line says what went wrong.
      const last = msg.trim().split('\n').pop() ?? msg;
      ctx.stderr.write(`ERROR: ${verbose ? msg.trim() : last}\n`);
      return 1;
    } finally {
      unbindIO(box);
    }
  });
}

export default async function pip(ctx: CommandContext): Promise<number> {
  return pipMain(ctx, ctx.args);
}
