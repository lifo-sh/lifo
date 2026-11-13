// About This Box: the Lifo menu's first item. Live uptime, processes, servers, files.

import type { AppDefinition, AppContext, AppInstance } from '../../types';
import type { DesktopWindow } from '../../core/Window';
import { APP_ICONS, LIFO_MARK } from '../../icons';
import { h } from '../../core/ui';
import { formatBytes, formatDuration } from '../../core/box';

class AboutInstance implements AppInstance {
  readonly appId = 'about';
  private timer = 0;
  private stats!: HTMLElement;
  private usage: { files: number; bytes: number; partial: boolean } | null = null;

  constructor(private ctx: AppContext) {}

  mount(container: HTMLElement, _win: DesktopWindow): void {
    this.stats = h('div', { class: 'lf-about-stats' });
    container.append(
      h(
        'div',
        { class: 'lf-about-box', 'data-drag': '' },
        h('div', { class: 'lf-about-logo', html: LIFO_MARK }),
        h('h2', {}, 'Lifo'),
        h('p', { class: 'lf-muted' }, 'A Linux-like OS in your browser tab'),
        this.stats,
        h(
          'div',
          { class: 'lf-dialog-buttons center', 'data-nodrag': '' },
          h('button', { class: 'lf-btn', onclick: () => this.ctx.launch('activity') }, 'Activity Monitor…'),
          h('a', { class: 'lf-btn', href: 'https://lifo.sh/docs', target: '_blank', rel: 'noopener' }, 'Documentation'),
        ),
      ),
    );
    this.render();
    this.timer = window.setInterval(() => this.render(), 1000);
  }

  private render(): void {
    const box = this.ctx.box;
    this.usage ??= box.usage('/');
    const row = (k: string, v: string) => h('div', { class: 'lf-info-row' }, h('span', {}, k), h('span', {}, v));
    this.stats.replaceChildren(
      row('Uptime', formatDuration(Date.now() - box.bootedAt)),
      row('Processes', String(box.processes.getAll().filter((p) => p.status !== 'zombie').length)),
      row('Servers', box.ports().length ? box.ports().map((p) => `:${p}`).join(' ') : 'none'),
      row('Files', `${this.usage.files.toLocaleString()}${this.usage.partial ? '+' : ''} · ${formatBytes(this.usage.bytes)}`),
      row('Runs on', navigator.userAgent.includes('Chrome') ? 'Chromium, in this tab' : 'this browser tab'),
    );
  }

  unmount(): void {
    clearInterval(this.timer);
  }

  getTitle(): string {
    return 'About This Box';
  }
}

export const aboutDefinition: AppDefinition = {
  id: 'about',
  name: 'About This Box',
  icon: APP_ICONS.about,
  singleton: true,
  hidden: true,
  size: { width: 340, height: 400 },
  minSize: { width: 300, height: 360 },
  createInstance: (ctx) => new AboutInstance(ctx),
};
