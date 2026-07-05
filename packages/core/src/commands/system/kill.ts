import type { Command } from '../types.js';
import type { ProcessRegistry } from '../../shell/ProcessRegistry.js';

const SIGNALS: Record<string, number> = {
  HUP: 1, INT: 2, QUIT: 3, KILL: 9, TERM: 15, STOP: 19, CONT: 18,
  SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGKILL: 9, SIGTERM: 15, SIGSTOP: 19, SIGCONT: 18,
};

const SIGNAL_NAMES: Record<number, string> = {
  1: 'HUP', 2: 'INT', 3: 'QUIT', 9: 'KILL', 15: 'TERM', 19: 'STOP', 18: 'CONT',
};

export function createKillCommand(processRegistry: ProcessRegistry): Command {
  return async (ctx) => {
    const args = ctx.args;

    if (args.length === 0) {
      ctx.stderr.write('kill: usage: kill [-signal] pid|%job ...\n');
      return 1;
    }

    // Handle -l (list signals)
    if (args[0] === '-l' || args[0] === '--list') {
      const names = Object.entries(SIGNAL_NAMES)
        .map(([num, name]) => `${String(num).padStart(2, ' ')}) ${name}`)
        .join('\n');
      ctx.stdout.write(names + '\n');
      return 0;
    }

    // Parse optional signal
    let startIdx = 0;
    let signalName: string | undefined;

    if (args[0].startsWith('-') && !args[0].startsWith('-%')) {
      const sigArg = args[0].slice(1);
      startIdx = 1;

      // Validate signal
      const num = parseInt(sigArg, 10);
      if (!isNaN(num) && SIGNAL_NAMES[num]) {
        signalName = SIGNAL_NAMES[num];
      } else if (SIGNALS[sigArg.toUpperCase()] !== undefined) {
        signalName = sigArg.toUpperCase();
      } else {
        ctx.stderr.write(`kill: invalid signal: ${sigArg}\n`);
        return 1;
      }
    }

    if (startIdx >= args.length) {
      ctx.stderr.write('kill: usage: kill [-signal] pid|%job ...\n');
      return 1;
    }

    let exitCode = 0;

    for (let i = startIdx; i < args.length; i++) {
      const target = args[i];

      let pid: number;

      if (target.startsWith('%')) {
        // Job spec: %N
        const jobId = parseInt(target.slice(1), 10);
        if (isNaN(jobId)) {
          ctx.stderr.write(`kill: ${target}: no such job\n`);
          exitCode = 1;
          continue;
        }

        // Look up process by job ID
        const proc = processRegistry.getByJobId(jobId);
        if (!proc) {
          ctx.stderr.write(`kill: ${target}: no such job\n`);
          exitCode = 1;
          continue;
        }
        pid = proc.pid;
      } else {
        // Direct PID
        pid = parseInt(target, 10);
        if (isNaN(pid)) {
          ctx.stderr.write(`kill: ${target}: invalid argument\n`);
          exitCode = 1;
          continue;
        }
      }

      // Kill the process
      const killed = processRegistry.kill(pid, signalName);
      if (!killed) {
        const proc = processRegistry.get(pid);
        if (proc && proc.command === 'shell') {
          ctx.stderr.write(`kill: (${pid}) - Operation not permitted (cannot kill shell)\n`);
        } else {
          ctx.stderr.write(`kill: (${pid}) - No such process\n`);
        }
        exitCode = 1;
      }
    }

    return exitCode;
  };
}
