import {
  Shell,
  HeadlessTerminal,
  createDefaultRegistry,
  createPsCommand,
  createKillCommand,
  type Kernel,
  type WorkerSandbox,
} from '@lifo-sh/core';

/** One row of `ps --json` — the VM's real process table. */
export interface ProcInfo {
  pid: number;
  ppid: number;
  command: string;
  args: string[];
  cwd: string;
  status: 'running' | 'sleeping' | 'stopped' | 'zombie';
  foreground: boolean;
  uptimeMs: number;
}

/** A box in the page: its kernel + a base env for the inspector shell. */
export interface KernelBox {
  kernel: Kernel;
  env: Record<string, string>;
}

/** A box in a Web Worker: reached only through its WorkerSandbox (ps/kill run in the box). */
export interface WorkerBox {
  worker: WorkerSandbox;
}

/** A box the process manager can inspect. */
export type InspectableBox = KernelBox | WorkerBox;

/**
 * A dedicated headless shell for reading/killing processes. It shares the
 * kernel's ProcessRegistry with the interactive terminals, so it sees (and can
 * signal) the same processes — but it has its OWN command queue. That matters:
 * an interactive shell is usually blocked on a foreground job (e.g. a dev
 * server), so `commands.run()` there would queue forever. This side shell runs
 * `ps`/`kill` immediately regardless.
 */
const shells = new WeakMap<object, Shell>();

function inspectorFor(box: KernelBox): Shell {
  const kernel = box.kernel;
  let shell = shells.get(kernel);
  if (shell) return shell;

  const registry = createDefaultRegistry();
  const pr = kernel.processRegistry;
  registry.register('ps', createPsCommand(pr));
  registry.register('kill', createKillCommand(pr));
  shell = new Shell(new HeadlessTerminal(), kernel.vfs, registry, box.env, pr);
  shells.set(kernel, shell);
  return shell;
}

/** Fetch the process table via `ps --json` (falls back to [] on any error). */
export async function listProcesses(box: InspectableBox): Promise<ProcInfo[]> {
  if ('worker' in box) {
    // The worker box's own shell has ps on its process table; commands.run doesn't wait for
    // the interactive terminal's foreground job (a dev server).
    try {
      const { stdout } = await box.worker.commands.run('ps --json');
      return JSON.parse(stdout.trim() || '[]') as ProcInfo[];
    } catch {
      return [];
    }
  }
  try {
    // A shell reaps finished/killed processes (zombies) before each prompt;
    // this inspector shell never prompts, so reap here — otherwise a killed
    // process lingers in the table forever instead of disappearing.
    box.kernel.processRegistry.collectZombies();
    const { stdout } = await inspectorFor(box).execute('ps --json');
    const rows = JSON.parse(stdout.trim() || '[]') as ProcInfo[];
    return rows;
  } catch {
    return [];
  }
}

/** Send SIGTERM to a pid via the `kill` command. */
export async function killProcess(box: InspectableBox, pid: number): Promise<boolean> {
  if ('worker' in box) {
    try {
      return (await box.worker.commands.run(`kill ${pid}`)).exitCode === 0;
    } catch {
      return false;
    }
  }
  try {
    const { exitCode } = await inspectorFor(box).execute(`kill ${pid}`);
    return exitCode === 0;
  } catch {
    return false;
  }
}
