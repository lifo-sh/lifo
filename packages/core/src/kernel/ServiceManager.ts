import type { VFS } from './vfs/index.js';
import type { CommandRegistry } from '../commands/registry.js';
import type { CommandContext, CommandOutputStream } from '../commands/types.js';
import { parseUnitFile } from './unit-parser.js';
import type { UnitFile } from './unit-parser.js';

export interface ServiceInfo {
  name: string;
  description: string;
  loaded: boolean;
  active: 'active' | 'inactive' | 'failed' | 'activating';
  sub: 'running' | 'dead' | 'exited' | 'start-pre' | 'auto-restart';
  enabled: boolean;
  pid: number | null;
  startedAt: number | null;
  exitCode: number | null;
}

const UNIT_DIR = '/etc/systemd/system';
const WANTS_DIR = '/etc/systemd/system/multi-user.target.wants';
const LOG_DIR = '/var/log';

let nextPid = 1000;

interface RunningService {
  name: string;
  unit: UnitFile;
  pid: number;
  startedAt: number;
  abortController: AbortController;
  promise: Promise<number>;
  exitCode: number | null;
  restartTimer: ReturnType<typeof setTimeout> | null;
}

export class ServiceManager {
  private vfs: VFS;
  private registry: CommandRegistry;
  private defaultEnv: Record<string, string>;
  private services = new Map<string, RunningService>();
  private unitCache = new Map<string, UnitFile>();

  constructor(vfs: VFS, registry: CommandRegistry, defaultEnv: Record<string, string>) {
    this.vfs = vfs;
    this.registry = registry;
    this.defaultEnv = defaultEnv;
  }

  /** Reload unit files from disk */
  daemonReload(): void {
    this.unitCache.clear();
  }

  private resolveUnit(name: string): UnitFile | null {
    const svcName = name.endsWith('.service') ? name : name + '.service';

    if (this.unitCache.has(svcName)) {
      return this.unitCache.get(svcName)!;
    }

    const path = UNIT_DIR + '/' + svcName;
    if (!this.vfs.exists(path)) return null;

    const content = this.vfs.readFileString(path);
    const unit = parseUnitFile(content);
    this.unitCache.set(svcName, unit);
    return unit;
  }

  private baseName(name: string): string {
    return name.endsWith('.service') ? name.slice(0, -8) : name;
  }

  async start(name: string): Promise<{ ok: boolean; message: string }> {
    const base = this.baseName(name);
    const existing = this.services.get(base);
    if (existing && existing.exitCode === null) {
      return { ok: true, message: '' }; // already running
    }

    const unit = this.resolveUnit(name);
    if (!unit) {
      return { ok: false, message: `Unit ${base}.service not found.` };
    }
    if (!unit.Service.ExecStart) {
      return { ok: false, message: `Unit ${base}.service has no ExecStart.` };
    }

    const pid = nextPid++;
    const abortController = new AbortController();
    const logPath = LOG_DIR + '/' + base + '.log';

    // Build an isolated CommandContext for the service
    const logStream: CommandOutputStream = {
      write: (text: string) => {
        try {
          const existing = this.vfs.exists(logPath)
            ? this.vfs.readFileString(logPath)
            : '';
          this.vfs.writeFile(logPath, existing + text);
        } catch { /* ignore log failures */ }
      },
    };

    const env = {
      ...this.defaultEnv,
      ...(unit.Service.Environment ?? {}),
    };
    const cwd = unit.Service.WorkingDirectory ?? this.defaultEnv.HOME ?? '/';

    // Parse ExecStart into command name + args
    const parts = unit.Service.ExecStart.split(/\s+/);
    const cmdName = parts[0];
    const cmdArgs = parts.slice(1);

    const cmd = await this.registry.resolve(cmdName);
    if (!cmd) {
      return { ok: false, message: `Command '${cmdName}' not found for ExecStart.` };
    }

    const ctx: CommandContext = {
      args: cmdArgs,
      env,
      cwd,
      vfs: this.vfs,
      stdout: logStream,
      stderr: logStream,
      signal: abortController.signal,
    };

    const promise = cmd(ctx).catch((err: unknown) => {
      if (abortController.signal.aborted) return -1;
      logStream.write(`Service error: ${err}\n`);
      return 1;
    });

    const svc: RunningService = {
      name: base,
      unit,
      pid,
      startedAt: Date.now(),
      abortController,
      promise,
      exitCode: null,
      restartTimer: null,
    };

    this.services.set(base, svc);

    // Handle service completion
    promise.then((code) => {
      svc.exitCode = code;
      this.handleServiceExit(svc);
    });

    return { ok: true, message: '' };
  }

  private handleServiceExit(svc: RunningService): void {
    const restart = svc.unit.Service.Restart ?? 'no';
    const shouldRestart =
      restart === 'always' ||
      (restart === 'on-failure' && svc.exitCode !== 0);

    if (shouldRestart && !svc.abortController.signal.aborted) {
      const delaySec = svc.unit.Service.RestartSec ?? 1;
      svc.restartTimer = setTimeout(() => {
        if (!svc.abortController.signal.aborted) {
          this.start(svc.name);
        }
      }, delaySec * 1000);
    }
  }

  async stop(name: string): Promise<{ ok: boolean; message: string }> {
    const base = this.baseName(name);
    const svc = this.services.get(base);

    if (!svc) {
      return { ok: false, message: `Unit ${base}.service not loaded.` };
    }

    // Cancel restart timer
    if (svc.restartTimer) {
      clearTimeout(svc.restartTimer);
      svc.restartTimer = null;
    }

    if (svc.exitCode !== null) {
      // Already stopped
      svc.exitCode = svc.exitCode;
      return { ok: true, message: '' };
    }

    // If there's an ExecStop command, try to run it
    if (svc.unit.Service.ExecStop) {
      const parts = svc.unit.Service.ExecStop.split(/\s+/);
      const cmd = await this.registry.resolve(parts[0]);
      if (cmd) {
        const noop: CommandOutputStream = { write: () => {} };
        try {
          await cmd({
            args: parts.slice(1),
            env: { ...this.defaultEnv },
            cwd: this.defaultEnv.HOME ?? '/',
            vfs: this.vfs,
            stdout: noop,
            stderr: noop,
            signal: AbortSignal.timeout(5000),
          });
        } catch { /* ignore */ }
      }
    }

    // Abort the running command
    svc.abortController.abort();
    svc.exitCode = -1;

    return { ok: true, message: '' };
  }

  async restart(name: string): Promise<{ ok: boolean; message: string }> {
    const base = this.baseName(name);
    const svc = this.services.get(base);
    if (svc && svc.exitCode === null) {
      await this.stop(base);
    }
    return this.start(base);
  }

  status(name: string): ServiceInfo {
    const base = this.baseName(name);
    const svc = this.services.get(base);
    const unit = this.resolveUnit(name);
    const enabled = this.isEnabled(base);

    if (!svc) {
      return {
        name: base,
        description: unit?.Unit.Description ?? '',
        loaded: unit !== null,
        active: 'inactive',
        sub: 'dead',
        enabled,
        pid: null,
        startedAt: null,
        exitCode: null,
      };
    }

    let active: ServiceInfo['active'];
    let sub: ServiceInfo['sub'];

    if (svc.exitCode === null) {
      active = 'active';
      sub = 'running';
    } else if (svc.exitCode === 0) {
      active = 'inactive';
      sub = 'exited';
    } else if (svc.abortController.signal.aborted) {
      active = 'inactive';
      sub = 'dead';
    } else {
      active = 'failed';
      sub = 'dead';
    }

    // Check if restarting
    if (svc.restartTimer) {
      active = 'activating';
      sub = 'auto-restart';
    }

    return {
      name: base,
      description: unit?.Unit.Description ?? svc.unit.Unit.Description ?? '',
      loaded: true,
      active,
      sub,
      enabled,
      pid: svc.exitCode === null ? svc.pid : null,
      startedAt: svc.startedAt,
      exitCode: svc.exitCode,
    };
  }

  enable(name: string): { ok: boolean; message: string } {
    const base = this.baseName(name);
    const unit = this.resolveUnit(name);
    if (!unit) {
      return { ok: false, message: `Unit ${base}.service not found.` };
    }

    const linkPath = WANTS_DIR + '/' + base + '.service';
    try {
      this.vfs.writeFile(linkPath, '');
    } catch {
      return { ok: false, message: `Failed to enable ${base}.service.` };
    }

    return { ok: true, message: `Created symlink ${linkPath}.` };
  }

  disable(name: string): { ok: boolean; message: string } {
    const base = this.baseName(name);
    const linkPath = WANTS_DIR + '/' + base + '.service';

    if (!this.vfs.exists(linkPath)) {
      return { ok: true, message: '' };
    }

    try {
      this.vfs.unlink(linkPath);
    } catch {
      return { ok: false, message: `Failed to disable ${base}.service.` };
    }

    return { ok: true, message: `Removed ${linkPath}.` };
  }

  private isEnabled(base: string): boolean {
    return this.vfs.exists(WANTS_DIR + '/' + base + '.service');
  }

  listUnits(): ServiceInfo[] {
    const units: ServiceInfo[] = [];
    const seen = new Set<string>();

    // Running services
    for (const [base] of this.services) {
      seen.add(base);
      units.push(this.status(base));
    }

    // Unit files on disk
    try {
      const entries = this.vfs.readdir(UNIT_DIR);
      for (const entry of entries) {
        if (entry.type === 'file' && entry.name.endsWith('.service')) {
          const base = entry.name.slice(0, -8);
          if (!seen.has(base)) {
            seen.add(base);
            units.push(this.status(base));
          }
        }
      }
    } catch { /* UNIT_DIR may not exist */ }

    return units;
  }

  async bootEnabledServices(): Promise<void> {
    try {
      const entries = this.vfs.readdir(WANTS_DIR);
      for (const entry of entries) {
        if (entry.type === 'file' && entry.name.endsWith('.service')) {
          const base = entry.name.slice(0, -8);
          await this.start(base);
        }
      }
    } catch { /* WANTS_DIR may not exist yet */ }
  }
}
