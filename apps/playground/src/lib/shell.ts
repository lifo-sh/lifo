import {
  Shell,
  createDefaultRegistry,
  bootLifoPackages,
  createPsCommand,
  createTopCommand,
  createKillCommand,
  createWatchCommand,
  createHelpCommand,
  createNodeCommand,
  createCurlCommand,
  createTunnelCommandV2,
  createIfconfigCommand,
  createRouteCommand,
  createNetstatCommand,
  createHostCommand,
  createIPCommand,
  createForwardCommand,
  createUnforwardCommand,
  createPortsCommand,
  createTestRegistryCommand,
  createNewtabCommand,
  createSystemctlCommand,
  createNpmCommand,
  createNpxCommand,
  createLifoPkgCommand,
  type Kernel,
} from '@lifo-sh/core';
import type { ITerminal } from '@lifo-sh/core';
import gitCommand from 'lifo-pkg-git';
import ffmpegCommand from 'lifo-pkg-ffmpeg';

export interface BootShellOptions {
  /** Extra installable-package commands to register. git is always
   *  registered ('git' entries are accepted for back-compat). */
  pkgs?: Array<'git' | 'ffmpeg'>;
  /** Register node/curl/tunnel + the network/systemctl command set. */
  network?: boolean;
  /** Boot enabled systemd services after sourcing profile (e.g. tunnel). */
  services?: boolean;
  /** Extra env merged over the kernel default (e.g. LIFO_CORS_PROXY for a
   *  second terminal in a project example). */
  env?: Record<string, string>;
  /** Initial working directory for this shell. */
  cwd?: string;
}

interface ShellExecCtx {
  cwd: string;
  env: Record<string, string>;
  stdout: { write: (s: string) => void };
  stderr: { write: (s: string) => void };
}

/**
 * The single source of truth for wiring a Shell onto a terminal + kernel.
 * Collapses the boilerplate that was duplicated across every boot function in
 * the old main.ts: registry + lifo packages + core commands + npm/npx/lifo +
 * (optionally) the network/systemctl command set, then sources profile/.bashrc
 * and starts the shell.
 */
export async function bootShell(
  terminal: ITerminal,
  kernel: Kernel,
  opts: BootShellOptions = {},
): Promise<Shell> {
  const registry = createDefaultRegistry();
  // git in every shell — it's statically imported anyway, and users expect
  // `git init`/`git status` to work in all examples.
  registry.register('git', gitCommand);
  if (opts.pkgs?.includes('ffmpeg')) registry.register('ffmpeg', ffmpegCommand);
  bootLifoPackages(kernel.vfs, registry);

  const env = { ...kernel.getDefaultEnv(), ...opts.env };
  if (opts.cwd) env.PWD = opts.cwd;
  const shell = new Shell(terminal, kernel.vfs, registry, env, kernel.processRegistry);
  const processRegistry = shell.getProcessRegistry();

  registry.register('ps', createPsCommand(processRegistry));
  registry.register('top', createTopCommand(processRegistry));
  registry.register('kill', createKillCommand(processRegistry));
  registry.register('watch', createWatchCommand(registry));
  registry.register('help', createHelpCommand(registry));

  const shellExecute = async (cmd: string, ctx: ShellExecCtx) => {
    const result = await shell.execute(cmd, {
      cwd: ctx.cwd,
      env: ctx.env,
      onStdout: (d: string) => ctx.stdout.write(d),
      onStderr: (d: string) => ctx.stderr.write(d),
    });
    return result.exitCode;
  };
  registry.register('npm', createNpmCommand(registry, shellExecute, kernel));
  registry.register('npx', createNpxCommand(registry, shellExecute));
  registry.register('lifo', createLifoPkgCommand(registry, shellExecute));

  if (opts.network) {
    registry.register('node', createNodeCommand(kernel));
    registry.register('curl', createCurlCommand(kernel));
    registry.register('tunnel', createTunnelCommandV2(kernel));
    registry.register('ifconfig', createIfconfigCommand(kernel));
    registry.register('route', createRouteCommand(kernel));
    registry.register('netstat', createNetstatCommand(kernel));
    registry.register('host', createHostCommand(kernel));
    registry.register('ip', createIPCommand(kernel));
    registry.register('forward', createForwardCommand(kernel));
    registry.register('unforward', createUnforwardCommand(kernel));
    registry.register('ports', createPortsCommand(kernel));
    registry.register('test-registry', createTestRegistryCommand(kernel));
    registry.register('newtab', createNewtabCommand());
    registry.register('systemctl', createSystemctlCommand(kernel));
  }

  await shell.sourceFile('/etc/profile');
  await shell.sourceFile(env.HOME + '/.bashrc');
  if (opts.cwd) shell.setCwd(opts.cwd);
  if (opts.services) await kernel.bootServices();
  shell.start();

  return shell;
}
