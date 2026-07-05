/**
 * Process information structure
 * Mirrors Linux process model with PID, PPID, status, etc.
 */
export interface Process {
  /** Process ID (unique identifier) */
  pid: number;

  /** Parent Process ID */
  ppid: number;

  /** Command name (argv[0]) */
  command: string;

  /** Full command line arguments */
  args: string[];

  /** Working directory when process started */
  cwd: string;

  /** Environment variables */
  env: Record<string, string>;

  /** Process start time (milliseconds since epoch) */
  startTime: number;

  /** Current process status */
  status: 'running' | 'sleeping' | 'stopped' | 'zombie';

  /** Whether this is a foreground process */
  isForeground: boolean;

  /** Promise that resolves when process completes */
  promise: Promise<number>;

  /** Controller for aborting/killing the process */
  abortController: AbortController;

  /** Exit code (null if still running) */
  exitCode: number | null;

  /** Optional job ID for background jobs (for backwards compat with JobTable) */
  jobId?: number;
}

/**
 * Options for spawning a new process
 */
export interface SpawnOptions {
  /** Command name */
  command: string;

  /** Command arguments (including command itself as args[0]) */
  args: string[];

  /** Working directory */
  cwd: string;

  /** Environment variables */
  env: Record<string, string>;

  /** Whether this is a foreground process */
  isForeground: boolean;

  /** Promise that resolves with exit code */
  promise: Promise<number>;

  /** Abort controller for killing the process */
  abortController: AbortController;

  /** Parent PID (defaults to 1 - shell) */
  ppid?: number;
}

/**
 * Central process registry for tracking all running processes.
 * Provides Linux-like process management with PIDs, status tracking,
 * and process lifecycle management.
 */
export class ProcessRegistry {
  private processes = new Map<number, Process>();
  private nextPid = 2; // PID 1 reserved for shell
  private nextJobId = 1; // Job IDs for background processes

  /**
   * Register the shell as a process.
   * @deprecated Use spawn() directly instead. Each shell gets its own PID.
   * Kept for backwards compatibility.
   */
  registerShell(_cwd: string, _env: Record<string, string>): void {
    // Deprecated: Each shell now registers itself via spawn() in Shell.start()
    // This is kept for backwards compatibility but does nothing
    // If you see this being called, update the code to use spawn() instead
  }

  /**
   * Spawn a new process and register it in the process table.
   * Returns the assigned PID.
   */
  spawn(opts: SpawnOptions): number {
    const pid = this.nextPid++;

    // Assign job ID for background processes
    const jobId = opts.isForeground ? undefined : this.nextJobId++;

    const process: Process = {
      pid,
      ppid: opts.ppid ?? 1, // Default parent is shell (PID 1)
      command: opts.command,
      args: opts.args,
      cwd: opts.cwd,
      env: opts.env,
      startTime: Date.now(),
      status: 'running',
      isForeground: opts.isForeground,
      promise: opts.promise,
      abortController: opts.abortController,
      exitCode: null,
      jobId,
    };

    // Auto-update status when promise resolves
    opts.promise.then((code) => {
      const proc = this.processes.get(pid);
      if (proc) {
        proc.status = 'zombie'; // Waiting for parent to reap
        proc.exitCode = code;
      }
    }).catch((error) => {
      const proc = this.processes.get(pid);
      if (proc) {
        proc.status = 'zombie';
        proc.exitCode = error?.exitCode ?? 1;
      }
    });

    this.processes.set(pid, process);
    return pid;
  }

  /**
   * Get process information by PID.
   */
  get(pid: number): Process | undefined {
    return this.processes.get(pid);
  }

  /**
   * Get process information by job ID.
   */
  getByJobId(jobId: number): Process | undefined {
    for (const proc of this.processes.values()) {
      if (proc.jobId === jobId) {
        return proc;
      }
    }
    return undefined;
  }

  /**
   * Check if a process exists.
   */
  has(pid: number): boolean {
    return this.processes.has(pid);
  }

  /**
   * Get all PIDs in the system.
   */
  getAllPIDs(): number[] {
    return Array.from(this.processes.keys()).sort((a, b) => a - b);
  }

  /**
   * Get all processes.
   */
  getAll(): Process[] {
    return Array.from(this.processes.values());
  }

  /**
   * Get all running processes (excludes zombies and stopped).
   */
  getRunning(): Process[] {
    return Array.from(this.processes.values()).filter(
      (p) => p.status === 'running' || p.status === 'sleeping'
    );
  }

  /**
   * Get all background jobs (non-foreground processes, excluding shell).
   */
  getBackgroundJobs(): Process[] {
    return Array.from(this.processes.values()).filter(
      (p) => !p.isForeground && p.pid !== 1
    );
  }

  /**
   * Get all zombie processes (finished but not reaped).
   */
  getZombies(): Process[] {
    return Array.from(this.processes.values()).filter(
      (p) => p.status === 'zombie'
    );
  }

  /**
   * Kill a process by sending abort signal.
   * Returns true if process was killed, false if not found or is a shell process.
   */
  kill(pid: number, signal?: string): boolean {
    const proc = this.processes.get(pid);
    if (!proc) {
      return false;
    }

    // Cannot kill shell processes (would close the terminal)
    if (proc.command === 'shell') {
      return false;
    }

    // Already dead
    if (proc.status === 'zombie') {
      return true;
    }

    // Send abort signal
    proc.abortController.abort();

    // Update status based on signal
    // SIGSTOP/SIGTSTP -> stopped, others -> keep running until process handles it
    if (signal === 'STOP' || signal === 'TSTP') {
      proc.status = 'stopped';
    }

    return true;
  }

  /**
   * Reap a zombie process (remove from process table).
   * This should be called after collecting exit code.
   * Returns true if process was reaped, false if not found or not a zombie.
   */
  reap(pid: number): boolean {
    const proc = this.processes.get(pid);

    // Only reap zombies (or explicitly stopped processes)
    if (!proc || (proc.status !== 'zombie' && proc.status !== 'stopped')) {
      return false;
    }

    // Cannot reap shell processes (they never exit)
    if (proc.command === 'shell') {
      return false;
    }

    this.processes.delete(pid);
    return true;
  }

  /**
   * Collect and reap all zombie processes.
   * Returns array of reaped processes for display/logging.
   */
  collectZombies(): Process[] {
    const zombies = this.getZombies().filter((p) => p.pid !== 1);

    for (const zombie of zombies) {
      this.processes.delete(zombie.pid);
    }

    return zombies;
  }

  /**
   * Update process status.
   * Useful for manual status changes (e.g., sleeping, stopped).
   */
  updateStatus(pid: number, status: Process['status']): boolean {
    const proc = this.processes.get(pid);
    if (!proc) {
      return false;
    }

    proc.status = status;
    return true;
  }

  /**
   * Get process uptime in milliseconds.
   */
  getUptime(pid: number): number | null {
    const proc = this.processes.get(pid);
    if (!proc) {
      return null;
    }

    return Date.now() - proc.startTime;
  }

  /**
   * Get formatted process info (for ps command).
   */
  getFormattedInfo(pid: number): string | null {
    const proc = this.processes.get(pid);
    if (!proc) {
      return null;
    }

    const uptime = Math.floor((Date.now() - proc.startTime) / 1000);
    const hours = Math.floor(uptime / 3600);
    const minutes = Math.floor((uptime % 3600) / 60);
    const seconds = uptime % 60;
    const time = `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;

    const statusSymbol = proc.status === 'zombie' ? ' <defunct>' :
                        proc.status === 'stopped' ? ' <stopped>' : '';

    // Show full command line with arguments
    const fullCommand = proc.args.join(' ');

    return `${proc.pid.toString().padStart(5)} pts/0    ${time} ${fullCommand}${statusSymbol}`;
  }

  /**
   * Get process count.
   */
  count(): number {
    return this.processes.size;
  }

  /**
   * Clear all processes except shell (useful for testing).
   */
  reset(): void {
    const shell = this.processes.get(1);
    this.processes.clear();
    if (shell) {
      this.processes.set(1, shell);
    }
    this.nextPid = 2;
    this.nextJobId = 1;
  }
}
