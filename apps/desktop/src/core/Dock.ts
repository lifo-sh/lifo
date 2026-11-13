// The Dock: pinned apps, then running apps that aren't pinned, then minimized windows and the
// Trash. Icons magnify under the pointer, running apps get a dot, launching bounces, a right
// click gives the app's menu, and files dragged from Finder onto the Trash are moved there.

import { h, showContextMenu, type MenuEntry } from './ui';
import { APP_ICONS, trashIcon } from '../icons';
import type { EventBus } from './EventBus';
import type { WindowManager } from './WindowManager';
import type { AppRegistry } from './AppRegistry';
import { compactMode, reducedMotion, type Settings } from './settings';
import type { AppContext } from '../types';

export const DRAG_MIME = 'application/x-lifo-path';

interface DockDeps {
  bus: EventBus;
  wm: WindowManager;
  registry: AppRegistry;
  settings: Settings;
  ctx: () => AppContext;
  pinned: string[];
  trashCount: () => number;
  moveToTrash: (paths: string[]) => void;
  emptyTrash: () => void;
}

export class Dock {
  readonly el: HTMLElement;
  private bar: HTMLElement;
  private label: HTMLElement;
  private icons: HTMLElement[] = [];
  private launching = new Set<string>();

  constructor(root: HTMLElement, private d: DockDeps) {
    this.bar = h('div', { class: 'lf-dock-bar', role: 'toolbar', 'aria-label': 'Dock' });
    this.label = h('div', { class: 'lf-dock-label' });
    this.el = h('div', { class: 'lf-dock' }, this.bar, this.label);
    root.append(this.el);

    d.wm.dockTargetFn = (appId, windowId) => {
      const el =
        this.bar.querySelector<HTMLElement>(`[data-window="${windowId}"]`) ??
        this.bar.querySelector<HTMLElement>(`[data-app="${appId}"]`) ??
        this.bar.querySelector<HTMLElement>('[data-app="trash"]');
      return el?.querySelector('.lf-dock-icon')?.getBoundingClientRect() ?? null;
    };

    for (const ev of ['window:open', 'window:close', 'window:minimize', 'window:restore', 'window:focus', 'trash:change'] as const) {
      d.bus.on(ev, (data) => {
        if (ev === 'window:open') this.launching.delete((data as { appId: string }).appId);
        this.render();
      });
    }
    d.bus.on('app:launch', ({ appId }) => this.bounce(appId));
    d.settings.onChange(() => this.render());
    window.addEventListener('resize', () => this.render());

    this.bar.addEventListener('pointermove', (e) => this.magnify(e.clientX));
    this.bar.addEventListener('pointerleave', () => {
      this.magnify(null);
      this.label.classList.remove('visible');
    });
    this.render();
  }

  private size(): number {
    return compactMode() ? 40 : this.d.settings.get('dockSize');
  }

  render(): void {
    const { wm, registry, pinned } = this.d;
    const running = wm.runningApps();
    const size = this.size();
    this.bar.replaceChildren();
    this.icons = [];
    this.bar.style.setProperty('--dock-size', `${size}px`);
    this.d.wm.dockReserve = size + 34;

    const appIds = [...pinned, ...running.filter((id) => !pinned.includes(id))];
    for (const id of appIds) {
      const def = registry.get(id);
      if (!def) continue;
      const item = this.item(def.icon, def.name, { 'data-app': id });
      if (running.includes(id)) item.classList.add('running');
      if (this.launching.has(id)) item.classList.add('bouncing');
      item.addEventListener('click', () => this.activate(id));
      item.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        showContextMenu(this.appMenu(id), e.clientX, e.clientY - 10);
      });
      this.bar.append(item);
    }

    this.bar.append(h('div', { class: 'lf-dock-sep' }));

    for (const w of wm.getAllWindows().filter((w) => w.state.minimized)) {
      const def = registry.get(w.state.appId);
      const item = this.item(def?.icon ?? APP_ICONS.about, w.state.title, { 'data-window': w.state.id });
      item.classList.add('minimized-window');
      item.addEventListener('click', () => wm.focusWindow(w.state.id));
      this.bar.append(item);
    }

    const full = this.d.trashCount() > 0;
    const trash = this.item(trashIcon(full), 'Trash', { 'data-app': 'trash' });
    trash.addEventListener('click', () => this.d.ctx().launch('finder', '/home/user/.Trash'));
    trash.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      showContextMenu(
        [
          { label: 'Open', action: () => this.d.ctx().launch('finder', '/home/user/.Trash') },
          { separator: true, label: '' },
          { label: 'Empty Trash', disabled: !full, action: () => this.d.emptyTrash() },
        ],
        e.clientX,
        e.clientY - 10,
      );
    });
    trash.addEventListener('dragover', (e) => {
      if (e.dataTransfer?.types.includes(DRAG_MIME)) {
        e.preventDefault();
        trash.classList.add('drop');
      }
    });
    trash.addEventListener('dragleave', () => trash.classList.remove('drop'));
    trash.addEventListener('drop', (e) => {
      e.preventDefault();
      trash.classList.remove('drop');
      const raw = e.dataTransfer?.getData(DRAG_MIME);
      if (raw) this.d.moveToTrash(JSON.parse(raw));
    });
    this.bar.append(trash);
  }

  private item(icon: string, label: string, attrs: Record<string, string>): HTMLElement {
    const iconEl = h('div', { class: 'lf-dock-icon', html: icon });
    const item = h('div', { class: 'lf-dock-item', role: 'button', tabindex: 0, 'aria-label': label, ...attrs }, iconEl, h('div', { class: 'lf-dock-dot' }));
    item.addEventListener('pointerenter', () => {
      this.label.textContent = label;
      this.label.classList.add('visible');
      requestAnimationFrame(() => {
        const r = iconEl.getBoundingClientRect();
        const lr = this.label.getBoundingClientRect();
        this.label.style.left = `${r.left + r.width / 2 - lr.width / 2 - this.el.getBoundingClientRect().left}px`;
      });
    });
    item.addEventListener('keydown', (e) => (e.key === 'Enter' || e.key === ' ') && item.click());
    this.icons.push(item);
    return item;
  }

  private activate(appId: string): void {
    const { wm } = this.d;
    const wins = wm.getWindowsByApp(appId);
    const focused = wm.getFocusedWindow();
    if (!wins.length) {
      this.d.ctx().launch(appId);
      return;
    }
    // Clicking the focused app with all its windows minimized brings one back; otherwise bring
    // its windows forward.
    if (focused?.state.appId === appId && wins.every((w) => !w.state.minimized) && wins.length === 1) return;
    wm.activateApp(appId);
  }

  private appMenu(appId: string): MenuEntry[] {
    const { wm, registry } = this.d;
    const wins = wm.getWindowsByApp(appId);
    const def = registry.get(appId);
    const items: MenuEntry[] = wins.map((w) => ({
      label: w.state.title,
      checked: wm.getFocusedWindow()?.state.id === w.state.id,
      action: () => wm.focusWindow(w.state.id),
    }));
    if (items.length) items.push({ separator: true, label: '' });
    if (!def?.singleton || !wins.length) items.push({ label: 'New Window', action: () => this.d.ctx().launch(appId) });
    if (wins.length) {
      items.push({ label: 'Show All Windows', action: () => wm.toggleOverview() });
      items.push({ separator: true, label: '' }, { label: 'Quit', action: () => void wm.quitApp(appId) });
    }
    return items;
  }

  private bounce(appId: string): void {
    if (this.d.wm.getWindowsByApp(appId).length || reducedMotion()) return;
    this.launching.add(appId);
    this.render();
    setTimeout(() => {
      this.launching.delete(appId);
      this.render();
    }, 1400);
  }

  /** macOS-style magnification: icons near the pointer grow along a cosine curve. */
  private magnify(x: number | null): void {
    const base = this.size();
    const max = this.d.settings.get('magnification') && !compactMode() && !reducedMotion() ? Math.max(base, this.d.settings.get('magnifiedSize')) : base;
    const range = base * 3;
    for (const item of this.icons) {
      const icon = item.querySelector<HTMLElement>('.lf-dock-icon')!;
      let s = base;
      if (x !== null && max > base) {
        const r = item.getBoundingClientRect();
        const d = Math.abs(x - (r.left + r.width / 2));
        if (d < range) s = base + (max - base) * Math.cos((d / range) * (Math.PI / 2));
      }
      icon.style.width = icon.style.height = `${s}px`;
    }
  }
}
