import type { Command } from '../types.js';
import type { ProcessRegistry } from '../../shell/ProcessRegistry.js';

export function createPsCommand(processRegistry: ProcessRegistry): Command {
  return async (ctx) => {
    ctx.stdout.write('  PID TTY          TIME CMD\n');

    // Get all processes from registry
    const processes = processRegistry.getAll();

    for (const proc of processes) {
      const info = processRegistry.getFormattedInfo(proc.pid);
      if (info) {
        ctx.stdout.write(info + '\n');
      }
    }

    return 0;
  };
}

// Legacy function for backward compatibility
export function createPsCommandFromJobTable(jobTable: any): Command {
  return async (ctx) => {
    ctx.stdout.write('  PID TTY          TIME CMD\n');

    // Shell is always PID 1
    ctx.stdout.write('    1 tty1     00:00:00 sh\n');

    // Background jobs
    const jobs = jobTable.list();
    for (const job of jobs) {
      const pid = String(job.id + 1).padStart(5, ' ');
      const status = job.status === 'running' ? '' : `  [${job.status}]`;
      // Extract command name (first word)
      const cmdName = job.command.split(/\s+/)[0];
      ctx.stdout.write(`${pid} tty1     00:00:00 ${cmdName}${status}\n`);
    }

    // ps itself is the last entry
    const psPid = String(jobs.length + 2).padStart(5, ' ');
    ctx.stdout.write(`${psPid} tty1     00:00:00 ps\n`);

    return 0;
  };
}
