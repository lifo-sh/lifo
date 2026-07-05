import { Terminal } from '@lifo-sh/ui';
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
} from '@lifo-sh/core';
import type { AppDefinition, AppContext, AppInstance, MenuCategory } from '../../types';

class TerminalInstance implements AppInstance {
  readonly appId = 'terminal';
  private terminal: Terminal | null = null;
  private shell: Shell | null = null;

  constructor(private ctx: AppContext) {}

  mount(container: HTMLElement): void {
    // Terminal needs a styled container
    const wrapper = document.createElement('div');
    wrapper.style.cssText = 'width:100%;height:100%;background:#1a1b26;';
    container.appendChild(wrapper);

    this.terminal = new Terminal(wrapper);

    const registry = createDefaultRegistry();
    bootLifoPackages(this.ctx.kernel.vfs, registry);

    const env = this.ctx.kernel.getDefaultEnv();
    this.shell = new Shell(this.terminal, this.ctx.kernel.vfs, registry, env);

    const jobTable = this.shell.getJobTable();
    registry.register('ps', createPsCommand(jobTable));
    registry.register('top', createTopCommand(jobTable));
    registry.register('kill', createKillCommand(jobTable));
    registry.register('watch', createWatchCommand(registry));
    registry.register('help', createHelpCommand(registry));
    registry.register('node', createNodeCommand(this.ctx.kernel));
    registry.register('curl', createCurlCommand(this.ctx.kernel));

    // Source profile files then start interactive
    (async () => {
      await this.shell!.sourceFile('/etc/profile');
      await this.shell!.sourceFile(env.HOME + '/.bashrc');
      this.shell!.start();
    })();
  }

  unmount(): void {
    this.shell = null;
    this.terminal = null;
  }

  focus(): void {
    this.terminal?.focus();
  }

  getTitle(): string {
    return 'Terminal';
  }

  getMenus(): MenuCategory[] {
    return [
      {
        label: 'Shell',
        items: [
          { label: 'New Window', shortcut: '\u2318N', action: () => {
            this.ctx.appRegistry.launch('terminal', this.ctx, this.ctx.windowManager);
          }},
          { separator: true, label: '' },
          { label: 'Clear', shortcut: '\u2318K', action: () => this.terminal?.clear() },
        ],
      },
    ];
  }
}

export const terminalDefinition: AppDefinition = {
  id: 'terminal',
  name: 'Terminal',
  icon: '\uD83D\uDDA5\uFE0F',
  createInstance: (ctx) => new TerminalInstance(ctx),
};
