// The menu bar: the Lifo menu, the focused app's name and menus on the left; the box's servers,
// appearance, Spotlight and the clock on the right. Menus open on click and follow the pointer
// across the bar while one is open, like macOS.

import { h, svg, renderMenu, trackMenu, untrackMenu, type MenuEntry } from './ui';
import { GLYPHS, LIFO_MARK } from '../icons';
import type { EventBus } from './EventBus';
import type { Settings } from './settings';

export interface MenuModel {
  lifo: MenuEntry[];
  appName: string;
  appMenu: MenuEntry[];
  categories: { label: string; items: MenuEntry[] }[];
}

export interface MenuBarDeps {
  bus: EventBus;
  settings: Settings;
  model: () => MenuModel;
  ports: () => number[];
  openPort: (port: number) => void;
  spotlight: () => void;
}

export class MenuBar {
  readonly el: HTMLElement;
  private left: HTMLElement;
  private clock: HTMLElement;
  private netBtn: HTMLElement;
  private themeBtn: HTMLElement;
  private open: { btn: HTMLElement; panel: HTMLElement } | null = null;

  constructor(root: HTMLElement, private deps: MenuBarDeps) {
    this.left = h('div', { class: 'lf-menubar-left', role: 'menubar' });
    this.netBtn = h('button', { class: 'lf-mb-status', title: 'Servers in this box' });
    this.themeBtn = h('button', { class: 'lf-mb-status', title: 'Appearance', onclick: () => this.toggleTheme() });
    const searchBtn = h('button', { class: 'lf-mb-status', title: 'Spotlight (⌥Space)', 'aria-label': 'Spotlight', onclick: () => deps.spotlight() }, svg(GLYPHS.search));
    this.clock = h('div', { class: 'lf-mb-clock', title: '' });
    const right = h('div', { class: 'lf-menubar-right' }, this.netBtn, this.themeBtn, searchBtn, this.clock);
    this.el = h('div', { class: 'lf-menubar' }, this.left, right);
    root.append(this.el);

    this.netBtn.addEventListener('click', () => this.toggle(this.netBtn, () => this.networkMenu()));
    for (const ev of ['window:focus', 'window:close', 'desktop:focus', 'menu:update', 'window:title'] as const) deps.bus.on(ev, () => this.render());
    deps.settings.onChange(() => this.renderStatus());
    document.addEventListener('pointerdown', (e) => {
      if (this.open && !this.el.contains(e.target as Node) && !this.open.panel.contains(e.target as Node)) this.close();
    }, true);
    document.addEventListener('keydown', (e) => e.key === 'Escape' && this.open && this.close());

    this.render();
    this.renderStatus();
    this.tick();
    setInterval(() => this.tick(), 10_000);
    setInterval(() => this.renderStatus(), 2000);
  }

  render(): void {
    const keep = this.open?.btn.dataset.key;
    this.close();
    const m = this.deps.model();
    this.left.replaceChildren();
    const add = (key: string, content: Node | string, items: () => MenuEntry[], cls = '') => {
      const btn = h('button', { class: `lf-mb-item ${cls}`, 'data-key': key, role: 'menuitem' }, content);
      btn.addEventListener('click', () => this.toggle(btn, items));
      btn.addEventListener('pointerenter', () => {
        if (this.open && this.open.btn !== btn) this.show(btn, items);
      });
      this.left.append(btn);
      return btn;
    };
    add('lifo', svg(LIFO_MARK, 'lf-mb-logo'), () => m.lifo, 'logo');
    add('app', m.appName, () => m.appMenu, 'app-name');
    for (const c of m.categories) add(`c:${c.label}`, c.label, () => c.items);
    if (keep) {
      const btn = this.left.querySelector<HTMLElement>(`[data-key="${CSS.escape(keep)}"]`);
      btn?.click();
    }
  }

  private toggle(btn: HTMLElement, items: () => MenuEntry[]): void {
    if (this.open?.btn === btn) this.close();
    else this.show(btn, items);
  }

  private show(btn: HTMLElement, items: () => MenuEntry[]): void {
    this.close();
    const panel = renderMenu(items(), () => this.close());
    panel.classList.add('lf-dropdown');
    document.getElementById('lf-overlay')!.append(panel);
    const r = btn.getBoundingClientRect();
    const pr = panel.getBoundingClientRect();
    panel.style.left = `${Math.max(4, Math.min(r.left, window.innerWidth - pr.width - 4))}px`;
    panel.style.top = `${r.bottom + 2}px`;
    btn.classList.add('open');
    this.open = { btn, panel };
    trackMenu(panel, () => this.close());
  }

  close(): void {
    if (!this.open) return;
    this.open.btn.classList.remove('open');
    this.open.panel.remove();
    untrackMenu(this.open.panel);
    this.open = null;
  }

  private networkMenu(): MenuEntry[] {
    const ports = this.deps.ports();
    const items: MenuEntry[] = ports.length
      ? ports.map((p) => ({ label: `localhost:${p}`, shortcut: 'Open', action: () => this.deps.openPort(p) }))
      : [{ label: 'No servers listening', disabled: true }];
    items.push(
      { separator: true, label: '' },
      { label: 'Share a port: lifo tunnel <port>', disabled: true },
      { label: 'Servers run inside this tab', disabled: true },
    );
    return items;
  }

  private toggleTheme(): void {
    const s = this.deps.settings;
    s.set('appearance', s.theme() === 'dark' ? 'light' : 'dark');
  }

  private renderStatus(): void {
    const n = this.deps.ports().length;
    this.netBtn.replaceChildren(svg(GLYPHS.network), n ? h('span', { class: 'lf-mb-badge' }, String(n)) : '');
    this.netBtn.title = n ? `${n} server${n > 1 ? 's' : ''} listening in this box` : 'No servers listening in this box';
    this.themeBtn.replaceChildren(svg(this.deps.settings.theme() === 'dark' ? GLYPHS.moon : GLYPHS.sun));
  }

  private tick(): void {
    const now = new Date();
    const day = now.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
    const time = now.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
    this.clock.textContent = `${day}  ${time}`;
    this.clock.title = now.toLocaleString();
  }
}
