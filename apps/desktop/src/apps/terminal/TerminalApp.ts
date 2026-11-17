// Terminal: shells on the desktop's box, in tabs. Every tab is its own shell over the same
// filesystem and processes, so `node server.js` in one tab shows up in Activity Monitor and the
// Browser. Opened from Finder it starts in that folder; from Spotlight it runs the command.

import { Terminal } from '@lifo-sh/ui';
import type { ITerminal, Shell } from '@lifo-sh/core';
import type { AppDefinition, AppContext, AppInstance, MenuCategory } from '../../types';
import type { DesktopWindow } from '../../core/Window';
import { APP_ICONS } from '../../icons';
import { h } from '../../core/ui';
import { HOME, dirname } from '../../core/box';

/** Wraps the xterm Terminal so the app can type into the shell as if the user did. */
class TabTerminal implements ITerminal {
  private listeners: ((d: string) => void)[] = [];
  constructor(readonly ui: Terminal) {
    ui.onData((d) => this.listeners.forEach((fn) => fn(d)));
  }
  write(d: string) {
    this.ui.write(d);
  }
  writeln(d: string) {
    this.ui.writeln(d);
  }
  onData(cb: (d: string) => void) {
    this.listeners.push(cb);
  }
  get cols() {
    return this.ui.cols;
  }
  get rows() {
    return this.ui.rows;
  }
  focus() {
    this.ui.focus();
  }
  clear() {
    this.ui.clear();
  }
  type(text: string) {
    this.listeners.forEach((fn) => fn(text));
  }
}

interface Tab {
  id: number;
  pane: HTMLElement;
  term: TabTerminal;
  shell: Shell | null;
  button: HTMLElement;
}

let nextTab = 1;

class TerminalInstance implements AppInstance {
  readonly appId = 'terminal';
  private win!: DesktopWindow;
  private tabs: Tab[] = [];
  private active: Tab | null = null;
  private tabBar!: HTMLElement;
  private panes!: HTMLElement;
  private titleTimer = 0;
  private cwd = HOME;
  private command: string | null = null;

  constructor(private ctx: AppContext, arg?: string) {
    if (arg?.startsWith('run:')) this.command = arg.slice(4);
    else if (arg) {
      const vfs = ctx.box.vfs;
      if (vfs.exists(arg)) this.cwd = vfs.stat(arg).type === 'directory' ? arg : dirname(arg);
    }
  }

  mount(container: HTMLElement, win: DesktopWindow): void {
    this.win = win;
    this.tabBar = h('div', { class: 'lf-tabs' });
    this.panes = h('div', { class: 'lf-term-panes' });
    container.append(h('div', { class: 'lf-terminal' }, this.tabBar, this.panes));
    this.newTab(this.cwd, this.command ?? undefined);
    this.titleTimer = window.setInterval(() => this.updateTitle(), 1000);
  }

  newTab(cwd = this.active?.shell?.getCwd() ?? this.cwd, command?: string): void {
    const pane = h('div', { class: 'lf-term-pane' });
    this.panes.append(pane);
    const term = new TabTerminal(new Terminal(pane, { fontSize: 13, webgl: false }));
    const id = nextTab++;
    const button = h('div', { class: 'lf-tab', role: 'tab' }, h('span', { class: 'lf-tab-label' }, 'Terminal'), h('button', { class: 'lf-tab-close', 'aria-label': 'Close tab', onclick: (e: Event) => (e.stopPropagation(), this.closeTab(tab)) }, '×'));
    button.addEventListener('click', () => this.activate(tab));
    const tab: Tab = { id, pane, term, shell: null, button };
    this.tabs.push(tab);
    this.tabBar.append(button);
    this.activate(tab);
    void this.ctx.box.newShell(term, cwd).then((shell) => {
      tab.shell = shell;
      this.updateTitle();
      if (command) setTimeout(() => term.type(command + '\r'), 50);
    });
    this.renderTabs();
  }

  private activate(tab: Tab): void {
    this.active = tab;
    for (const t of this.tabs) {
      t.pane.classList.toggle('active', t === tab);
      t.button.classList.toggle('active', t === tab);
    }
    tab.term.ui.refit();
    setTimeout(() => tab.term.focus());
    this.updateTitle();
  }

  private closeTab(tab: Tab): void {
    if (this.tabs.length === 1) {
      void this.ctx.windowManager.closeWindow(this.win.state.id);
      return;
    }
    const i = this.tabs.indexOf(tab);
    this.tabs.splice(i, 1);
    tab.term.ui.dispose();
    this.ctx.box.endShell(tab.shell);
    tab.pane.remove();
    tab.button.remove();
    if (this.active === tab) this.activate(this.tabs[Math.max(0, i - 1)]);
    this.renderTabs();
  }

  private renderTabs(): void {
    this.tabBar.classList.toggle('visible', this.tabs.length > 1);
    for (const t of this.tabs) t.term.ui.refit();
  }

  private label(t: Tab): string {
    const cwd = t.shell?.getCwd() ?? this.cwd;
    return cwd === HOME ? '~' : cwd.startsWith(HOME + '/') ? '~' + cwd.slice(HOME.length) : cwd;
  }

  private updateTitle(): void {
    for (const t of this.tabs) t.button.querySelector('.lf-tab-label')!.textContent = this.label(t);
    if (!this.active || !this.win) return;
    const title = `user@lifo: ${this.label(this.active)} — ${this.active.term.cols}×${this.active.term.rows}`;
    if (title !== this.win.state.title) this.ctx.windowManager.setTitle(this.win.state.id, title);
  }

  unmount(): void {
    clearInterval(this.titleTimer);
    for (const t of this.tabs) {
      t.term.ui.dispose();
      this.ctx.box.endShell(t.shell);
    }
    this.tabs = [];
  }

  focus(): void {
    this.active?.term.focus();
  }

  onResize(): void {
    this.active?.term.ui.refit();
  }

  getTitle(): string {
    return 'Terminal';
  }

  getMenus(): MenuCategory[] {
    return [
      {
        label: 'Shell',
        items: [
          { label: 'New Tab', shortcut: '⌥T', action: () => this.newTab() },
          { label: 'New Window', shortcut: '⌥N', action: () => this.ctx.launch('terminal', this.active?.shell?.getCwd()) },
          { separator: true, label: '' },
          { label: 'Close Tab', disabled: this.tabs.length < 2, action: () => this.active && this.closeTab(this.active) },
          { label: 'Open Folder in Finder', action: () => this.ctx.launch('finder', this.active?.shell?.getCwd() ?? HOME) },
        ],
      },
      {
        label: 'View',
        items: [
          { label: 'Clear', shortcut: '⌘K', action: () => this.active?.term.clear() },
          { label: 'Bigger Text', action: () => this.font(1) },
          { label: 'Smaller Text', action: () => this.font(-1) },
        ],
      },
    ];
  }

  private fontSize = 13;
  private font(d: number): void {
    this.fontSize = Math.min(24, Math.max(10, this.fontSize + d));
    for (const t of this.tabs) t.term.ui.setFontSize(this.fontSize);
  }

  /** Called by the desktop for ⌥T. */
  static newTabIn(inst: AppInstance | null): boolean {
    if (inst instanceof TerminalInstance) {
      inst.newTab();
      return true;
    }
    return false;
  }
}

export const newTerminalTab = TerminalInstance.newTabIn;

export const terminalDefinition: AppDefinition = {
  id: 'terminal',
  name: 'Terminal',
  icon: APP_ICONS.terminal,
  size: { width: 720, height: 440 },
  minSize: { width: 360, height: 200 },
  createInstance: (ctx, arg) => new TerminalInstance(ctx, arg),
};
