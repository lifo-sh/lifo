import type { Command } from '../types.js';
import type { ProcessRegistry } from '../../shell/ProcessRegistry.js';

export function createTopCommand(processRegistry: ProcessRegistry): Command {
  return async (ctx) => {
    const now = new Date();
    const hours = String(now.getHours()).padStart(2, '0');
    const mins = String(now.getMinutes()).padStart(2, '0');
    const secs = String(now.getSeconds()).padStart(2, '0');

    // Uptime from performance.now()
    const uptimeMs = typeof performance !== 'undefined' ? performance.now() : 0;
    const uptimeMin = Math.floor(uptimeMs / 60000);

    // CPU info
    const cpuCores = typeof navigator !== 'undefined' ? navigator.hardwareConcurrency || 1 : 1;

    // Memory info
    const perfMemory = typeof performance !== 'undefined' ? (performance as any).memory : undefined;
    const totalMem = perfMemory ? Math.round(perfMemory.jsHeapSizeLimit / (1024 * 1024)) : 256;
    const usedMem = perfMemory ? Math.round(perfMemory.usedJSHeapSize / (1024 * 1024)) : 16;
    const freeMem = totalMem - usedMem;

    // Process list
    const processes = processRegistry.getAll();
    const runningCount = processes.filter(p => p.status === 'running' || p.status === 'sleeping').length;
    const stoppedCount = processes.filter(p => p.status === 'stopped').length;
    const totalTasks = processes.length;

    ctx.stdout.write(`top - ${hours}:${mins}:${secs} up ${uptimeMin} min,  1 user\n`);
    ctx.stdout.write(`Tasks: ${String(totalTasks).padStart(3, ' ')} total, ${String(runningCount).padStart(3, ' ')} running, ${String(stoppedCount).padStart(3, ' ')} stopped\n`);
    ctx.stdout.write(`%Cpu(s): ${cpuCores} cores\n`);
    ctx.stdout.write(`MiB Mem: ${String(totalMem).padStart(7, ' ')} total ${String(usedMem).padStart(7, ' ')} used ${String(freeMem).padStart(7, ' ')} free\n`);
    ctx.stdout.write('\n');
    ctx.stdout.write('  PID CMD            STATUS\n');

    // All processes
    for (const proc of processes) {
      const pid = String(proc.pid).padStart(5, ' ');
      const cmdName = proc.command.padEnd(15, ' ').slice(0, 15);
      ctx.stdout.write(`${pid} ${cmdName}${proc.status}\n`);
    }

    return 0;
  };
}
