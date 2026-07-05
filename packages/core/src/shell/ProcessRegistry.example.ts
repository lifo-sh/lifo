// @ts-nocheck
/**
 * ProcessRegistry Usage Examples
 *
 * This file demonstrates how to use the ProcessRegistry for Linux-like
 * process management in lifo.
 */

import { ProcessRegistry } from './ProcessRegistry.js';

// ─── Example 1: Initialize with Shell ───

function example1_InitializeRegistry() {
  const registry = new ProcessRegistry();

  // Register shell as PID 1 (should be done once during shell boot)
  registry.registerShell('/home/user', { HOME: '/home/user', PATH: '/bin:/usr/bin' });

  console.log('Shell registered:', registry.get(1));
  // Output: { pid: 1, ppid: 0, command: 'shell', status: 'running', ... }
}

// ─── Example 2: Spawn Foreground Process ───

async function example2_ForegroundProcess() {
  const registry = new ProcessRegistry();
  registry.registerShell('/home/user', {});

  // Simulate a foreground command execution
  const abortController = new AbortController();
  const promise = new Promise<number>((resolve) => {
    setTimeout(() => resolve(0), 1000); // Command takes 1 second
  });

  const pid = registry.spawn({
    command: 'ls',
    args: ['ls', '-la', '/home'],
    cwd: '/home/user',
    env: {},
    isForeground: true,
    promise,
    abortController,
  });

  console.log('Spawned foreground process:', pid);
  console.log('Process info:', registry.get(pid));

  // Wait for completion
  await promise;

  console.log('Process after completion:', registry.get(pid));
  // Status will be 'zombie'

  // Reap the zombie
  registry.reap(pid);
  console.log('Process reaped, exists:', registry.has(pid)); // false
}

// ─── Example 3: Spawn Background Process (Job) ───

async function example3_BackgroundJob() {
  const registry = new ProcessRegistry();
  registry.registerShell('/home/user', {});

  const abortController = new AbortController();
  const promise = new Promise<number>((resolve) => {
    setTimeout(() => resolve(0), 5000); // Long-running job
  });

  const pid = registry.spawn({
    command: 'node',
    args: ['node', 'server.js'],
    cwd: '/home/user',
    env: {},
    isForeground: false, // Background!
    promise,
    abortController,
  });

  console.log('Background job PID:', pid);

  const process = registry.get(pid);
  console.log('Job ID:', process?.jobId); // Auto-assigned job ID
  console.log('Is foreground:', process?.isForeground); // false

  // List all background jobs
  const jobs = registry.getBackgroundJobs();
  console.log('Background jobs:', jobs.map(j => ({ pid: j.pid, jobId: j.jobId, cmd: j.command })));
}

// ─── Example 4: Kill a Process ───

async function example4_KillProcess() {
  const registry = new ProcessRegistry();
  registry.registerShell('/home/user', {});

  let wasAborted = false;
  const abortController = new AbortController();
  const promise = new Promise<number>((resolve) => {
    abortController.signal.addEventListener('abort', () => {
      wasAborted = true;
      resolve(130); // Exit code for SIGINT
    });
    setTimeout(() => resolve(0), 10000); // Long-running
  });

  const pid = registry.spawn({
    command: 'sleep',
    args: ['sleep', '10'],
    cwd: '/home/user',
    env: {},
    isForeground: false,
    promise,
    abortController,
  });

  console.log('Started process:', pid);

  // Kill it after 100ms
  setTimeout(() => {
    const killed = registry.kill(pid);
    console.log('Killed:', killed); // true
    console.log('Was aborted:', wasAborted); // true
  }, 100);

  const exitCode = await promise;
  console.log('Exit code:', exitCode); // 130
}

// ─── Example 5: Process Status Tracking ───

async function example5_StatusTracking() {
  const registry = new ProcessRegistry();
  registry.registerShell('/home/user', {});

  const abortController = new AbortController();
  const promise = new Promise<number>((resolve) => {
    setTimeout(() => resolve(0), 1000);
  });

  const pid = registry.spawn({
    command: 'grep',
    args: ['grep', 'pattern', 'file.txt'],
    cwd: '/home/user',
    env: {},
    isForeground: true,
    promise,
    abortController,
  });

  console.log('Initial status:', registry.get(pid)?.status); // 'running'

  // Simulate process sleeping (e.g., waiting for I/O)
  registry.updateStatus(pid, 'sleeping');
  console.log('Updated status:', registry.get(pid)?.status); // 'sleeping'

  await promise;
  console.log('Final status:', registry.get(pid)?.status); // 'zombie'
}

// ─── Example 6: List All Processes (like ps) ───

function example6_ListProcesses() {
  const registry = new ProcessRegistry();
  registry.registerShell('/home/user', {});

  // Spawn several processes
  for (let i = 0; i < 3; i++) {
    registry.spawn({
      command: `process${i}`,
      args: [`process${i}`],
      cwd: '/home/user',
      env: {},
      isForeground: i === 0,
      promise: new Promise(() => {}),
      abortController: new AbortController(),
    });
  }

  console.log('All PIDs:', registry.getAllPIDs()); // [1, 2, 3, 4]

  console.log('\nAll processes:');
  for (const proc of registry.getAll()) {
    console.log(`PID ${proc.pid}: ${proc.command} (${proc.status})`);
  }

  console.log('\nRunning processes:', registry.getRunning().length);
  console.log('Background jobs:', registry.getBackgroundJobs().length);
}

// ─── Example 7: Zombie Collection ───

async function example7_ZombieCollection() {
  const registry = new ProcessRegistry();
  registry.registerShell('/home/user', {});

  // Spawn processes that finish quickly
  const promises: Promise<number>[] = [];

  for (let i = 0; i < 3; i++) {
    const promise = Promise.resolve(i);
    promises.push(promise);

    registry.spawn({
      command: `cmd${i}`,
      args: [`cmd${i}`],
      cwd: '/home/user',
      env: {},
      isForeground: false,
      promise,
      abortController: new AbortController(),
    });
  }

  // Wait for all to finish
  await Promise.all(promises);

  console.log('Zombies:', registry.getZombies().length); // 3

  // Collect and reap all zombies
  const reaped = registry.collectZombies();
  console.log('Reaped processes:', reaped.map(p => ({ pid: p.pid, exitCode: p.exitCode })));
  console.log('Remaining processes:', registry.count()); // 1 (just shell)
}

// ─── Example 8: Process Uptime ───

async function example8_ProcessUptime() {
  const registry = new ProcessRegistry();
  registry.registerShell('/home/user', {});

  const pid = registry.spawn({
    command: 'long-running',
    args: ['long-running'],
    cwd: '/home/user',
    env: {},
    isForeground: false,
    promise: new Promise(() => {}),
    abortController: new AbortController(),
  });

  console.log('Initial uptime:', registry.getUptime(pid), 'ms');

  await new Promise(resolve => setTimeout(resolve, 1000));

  console.log('After 1 second:', registry.getUptime(pid), 'ms'); // ~1000

  console.log('\nFormatted info:');
  console.log(registry.getFormattedInfo(pid));
  // "    2 pts/0    00:00:01 long-running"
}

// ─── Example 9: Cannot Kill Shell (PID 1) ───

function example9_CannotKillShell() {
  const registry = new ProcessRegistry();
  registry.registerShell('/home/user', {});

  const killed = registry.kill(1);
  console.log('Attempted to kill shell:', killed); // false

  const reaped = registry.reap(1);
  console.log('Attempted to reap shell:', reaped); // false

  console.log('Shell still exists:', registry.has(1)); // true
}

// ─── Example 10: Integration with Shell Execution ───

async function example10_ShellIntegration() {
  const registry = new ProcessRegistry();
  registry.registerShell('/home/user', { HOME: '/home/user' });

  // Simulating shell executing: node server.js &
  async function executeCommand(command: string, args: string[], isBackground: boolean) {
    const abortController = new AbortController();

    // Simulate command execution
    const promise = new Promise<number>((resolve) => {
      const cleanup = () => {
        if (abortController.signal.aborted) {
          resolve(130);
        } else {
          resolve(0);
        }
      };

      abortController.signal.addEventListener('abort', cleanup);
      setTimeout(cleanup, 2000);
    });

    const pid = registry.spawn({
      command,
      args: [command, ...args],
      cwd: '/home/user',
      env: { HOME: '/home/user' },
      isForeground: !isBackground,
      promise,
      abortController,
    });

    if (isBackground) {
      const proc = registry.get(pid);
      console.log(`[${proc?.jobId}] ${pid} (background)`);
      return pid;
    } else {
      // Wait for foreground process
      const exitCode = await promise;
      registry.reap(pid);
      return exitCode;
    }
  }

  // Execute background command
  await executeCommand('node', ['server.js'], true);

  // Execute foreground command
  await executeCommand('ls', ['-la'], false);

  // Show all processes
  console.log('\nCurrent processes:');
  for (const proc of registry.getRunning()) {
    console.log(`  PID ${proc.pid}: ${proc.command} ${proc.isForeground ? '(fg)' : '(bg)'}`);
  }
}

// ─── Run Examples ───

if (import.meta.url === `file://${process.argv[1]}`) {
  console.log('=== Example 1: Initialize Registry ===');
  example1_InitializeRegistry();

  console.log('\n=== Example 6: List Processes ===');
  example6_ListProcesses();

  console.log('\n=== Example 9: Cannot Kill Shell ===');
  example9_CannotKillShell();
}
