// Activity Monitor: what's running in the box. Processes (with Quit), servers listening on ports,
// and memory and disk use. Refreshes every second while open.

import type { AppDefinition, AppContext, AppInstance, MenuCategory } from '../../types';
import type { DesktopWindow } from '../../core/Window';
import { APP_ICONS, GLYPHS } from '../../icons';
import { h, svg, confirmDialog } from '../../core/ui';
import { formatBytes, formatDuration } from '../../core/box';

type Tab = 'processes' | 'servers' | 'memory';

class ActivityInstance implements AppInstance {
  readonly appId = 'activity';
  private tab: Tab = 'processes';
  private selected: number | null = null;
  private filter = '';
  private timer = 0;
  private body!: HTMLElement;
  private seg!: HTMLElement;
  private quitBtn!: HTMLButtonElement;
  private footer!: HTMLElement;
  private disk: { files: number; bytes: number; partial: boolean; at: number } | null = null;

  constructor(private ctx: AppContext) {}

  mount(container: HTMLElement, _win: DesktopWindow): void {
    this.quitBtn = h('button', { class: 'lf-tb-btn', title: 'Quit process', 'aria-label': 'Quit process', onclick: () => void this.quit() }, svg(GLYPHS.stop)) as HTMLButtonElement;
    const tabBtn = (t: Tab, label: string) => h('button', { 'data-tab': t, onclick: () => this.setTab(t) }, label);
    this.seg = h('div', { class: 'lf-segmented text', 'data-nodrag': '' }, tabBtn('processes', 'Processes'), tabBtn('servers', 'Servers'), tabBtn('memory', 'Memory'));
    const search = h('input', { class: 'lf-search', placeholder: 'Search', 'aria-label': 'Filter' }) as HTMLInputElement;
    search.addEventListener('input', () => ((this.filter = search.value.toLowerCase()), this.render()));
    const toolbar = h(
      'div',
      { class: 'lf-toolbar', 'data-drag': '' },
      h('div', { class: 'lf-toolbar-title' }, 'Activity Monitor'),
      this.quitBtn,
      h('div', { class: 'lf-tb-spacer' }),
      this.seg,
      h('div', { class: 'lf-tb-spacer' }),
      h('div', { class: 'lf-search-wrap' }, svg(GLYPHS.search), search),
    );
    this.body = h('div', { class: 'lf-activity-body' });
    this.footer = h('div', { class: 'lf-activity-footer' });
    container.append(h('div', { class: 'lf-activity' }, toolbar, this.body, this.footer));
    this.render();
    this.timer = window.setInterval(() => this.render(), 1000);
  }

  private setTab(t: Tab): void {
    this.tab = t;
    this.selected = null;
    this.render();
  }

  private render(): void {
    for (const b of this.seg.querySelectorAll<HTMLElement>('button')) b.classList.toggle('active', b.dataset.tab === this.tab);
    this.quitBtn.disabled = this.tab !== 'processes' || this.selected === null;
    if (this.tab === 'processes') this.renderProcesses();
    else if (this.tab === 'servers') this.renderServers();
    else this.renderMemory();
    this.renderFooter();
  }

  private table(head: string[], rows: { key: string | number; cells: (string | Node)[]; onclick?: () => void; ondbl?: () => void; selected?: boolean }[], cls: string): HTMLElement {
    const t = h('div', { class: `lf-table ${cls}` }, h('div', { class: 'lf-table-head' }, ...head.map((x) => h('span', {}, x))));
    const scroll = this.body.querySelector('.lf-table-rows')?.scrollTop ?? 0;
    const rowsEl = h('div', { class: 'lf-table-rows' });
    for (const r of rows) {
      const row = h('div', { class: `lf-table-row${r.selected ? ' selected' : ''}`, 'data-key': String(r.key) }, ...r.cells.map((c) => h('span', {}, c)));
      if (r.onclick) row.addEventListener('click', r.onclick);
      if (r.ondbl) row.addEventListener('dblclick', r.ondbl);
      rowsEl.append(row);
    }
    if (!rows.length) rowsEl.append(h('div', { class: 'lf-empty' }, 'Nothing here'));
    t.append(rowsEl);
    this.body.replaceChildren(t);
    rowsEl.scrollTop = scroll;
    return t;
  }

  private renderProcesses(): void {
    const procs = this.ctx.box.processes
      .getAll()
      .filter((p) => p.status !== 'zombie')
      .filter((p) => !this.filter || `${p.command} ${p.args.join(' ')}`.toLowerCase().includes(this.filter))
      .sort((a, b) => a.pid - b.pid);
    if (this.selected !== null && !procs.some((p) => p.pid === this.selected)) this.selected = null;
    this.table(
      ['PID', 'Process', 'State', 'Kind', 'Running for'],
      procs.map((p) => ({
        key: p.pid,
        selected: p.pid === this.selected,
        cells: [String(p.pid), p.command === 'shell' ? 'shell (Terminal)' : [p.command, ...p.args.slice(p.args[0] === p.command ? 1 : 0)].join(' ').slice(0, 80), p.status, p.isForeground ? 'foreground' : 'background', formatDuration(Date.now() - p.startTime)],
        onclick: () => {
          this.selected = p.pid;
          this.render();
        },
        ondbl: () => void this.quit(),
      })),
      'procs',
    );
  }

  private renderServers(): void {
    const ports = this.ctx.box.ports().filter((p) => !this.filter || String(p).includes(this.filter));
    this.table(
      ['Port', 'Address', ''],
      ports.map((p) => ({
        key: p,
        cells: [String(p), `localhost:${p}`, h('button', { class: 'lf-btn small', onclick: () => this.ctx.launch('browser', String(p)) }, 'Open in Browser')],
      })),
      'servers',
    );
  }

  private renderMemory(): void {
    const mem = (performance as Performance & { memory?: { usedJSHeapSize: number; totalJSHeapSize: number; jsHeapSizeLimit: number } }).memory;
    if (!this.disk || Date.now() - this.disk.at > 5000) this.disk = { ...this.ctx.box.usage('/'), at: Date.now() };
    const stat = (label: string, value: string, sub = '') => h('div', { class: 'lf-stat' }, h('small', {}, label), h('b', {}, value), sub ? h('small', {}, sub) : null);
    const pct = mem ? Math.round((mem.usedJSHeapSize / mem.jsHeapSizeLimit) * 100) : 0;
    this.body.replaceChildren(
      h(
        'div',
        { class: 'lf-stats' },
        stat('JavaScript heap', mem ? formatBytes(mem.usedJSHeapSize) : 'n/a', mem ? `of ${formatBytes(mem.jsHeapSizeLimit)} (${pct}%)` : 'This browser does not report it'),
        stat('Files in the box', `${this.disk.files.toLocaleString()}${this.disk.partial ? '+' : ''}`, formatBytes(this.disk.bytes)),
        stat('Processes', String(this.ctx.box.processes.getAll().filter((p) => p.status !== 'zombie').length)),
        stat('Servers', String(this.ctx.box.ports().length)),
        stat('Uptime', formatDuration(Date.now() - this.ctx.box.bootedAt)),
      ),
      ...(mem ? [h('div', { class: 'lf-meter' }, h('div', { style: `width:${pct}%` }))] : []),
    );
  }

  private renderFooter(): void {
    const n = this.ctx.box.processes.getAll().filter((p) => p.status !== 'zombie').length;
    this.footer.textContent = `${n} processes · ${this.ctx.box.ports().length} servers · up ${formatDuration(Date.now() - this.ctx.box.bootedAt)}`;
  }

  private async quit(): Promise<void> {
    if (this.selected === null) return;
    const p = this.ctx.box.processes.get(this.selected);
    if (!p) return;
    const ok = await confirmDialog(`Quit “${p.command}” (PID ${p.pid})?`, p.command === 'shell' ? 'This ends a Terminal tab’s shell.' : 'The process is stopped.', 'Quit', true);
    if (!ok) return;
    this.ctx.box.processes.kill(p.pid);
    this.selected = null;
    this.render();
  }

  unmount(): void {
    clearInterval(this.timer);
  }

  getTitle(): string {
    return 'Activity Monitor';
  }

  getMenus(): MenuCategory[] {
    return [
      {
        label: 'View',
        items: [
          { label: 'Processes', checked: this.tab === 'processes', action: () => this.setTab('processes') },
          { label: 'Servers', checked: this.tab === 'servers', action: () => this.setTab('servers') },
          { label: 'Memory', checked: this.tab === 'memory', action: () => this.setTab('memory') },
          { separator: true, label: '' },
          { label: 'Quit Process', disabled: this.selected === null, action: () => void this.quit() },
        ],
      },
    ];
  }
}

export const activityDefinition: AppDefinition = {
  id: 'activity',
  name: 'Activity Monitor',
  icon: APP_ICONS.activity,
  chrome: 'unified',
  singleton: true,
  size: { width: 720, height: 440 },
  minSize: { width: 480, height: 260 },
  createInstance: (ctx) => new ActivityInstance(ctx),
};
