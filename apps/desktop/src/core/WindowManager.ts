// Window manager: creates windows for app instances, keeps focus and stacking order, minimizes
// into the Dock, zooms, snaps, remembers each app's last window size and position, and shows all
// windows side by side (Mission Control-lite).

import { DesktopWindow, type Rect, type WindowHost } from './Window';
import type { EventBus } from './EventBus';
import type { AppDefinition, AppInstance, WindowState } from '../types';
import { compactMode, reducedMotion, type Settings } from './settings';
import { h } from './ui';

export const MENUBAR_HEIGHT = 28;
const CASCADE = 26;

export class WindowManager implements WindowHost {
  private windows = new Map<string, DesktopWindow>();
  private z = 100;
  private cascade = 0;
  private focusedId: string | null = null;
  private snapEl: HTMLElement;
  private overviewOn = false;
  /** Set by the Dock: its height and how to find an app's icon. */
  dockReserve = 84;
  dockTargetFn: (appId: string, windowId: string) => DOMRect | null = () => null;

  constructor(
    private bus: EventBus,
    private layer: HTMLElement,
    private settings: Settings,
  ) {
    this.snapEl = h('div', { class: 'lf-snap-preview' });
    layer.append(this.snapEl);
    window.addEventListener('resize', () => {
      for (const w of this.windows.values()) w.fitToArea();
    });
  }

  // ─── WindowHost ───

  area(): Rect {
    const top = MENUBAR_HEIGHT;
    const bottom = compactMode() ? 64 : this.dockReserve;
    return { x: 0, y: top, width: window.innerWidth, height: Math.max(200, window.innerHeight - top - bottom) };
  }

  compact(): boolean {
    return compactMode();
  }

  dockTarget(appId: string, windowId: string): DOMRect | null {
    return this.dockTargetFn(appId, windowId);
  }

  snapPreview(rect: Rect | null): void {
    this.snapEl.classList.toggle('visible', !!rect);
    if (rect) Object.assign(this.snapEl.style, { left: `${rect.x + 6}px`, top: `${rect.y + 6}px`, width: `${rect.width - 12}px`, height: `${rect.height - 12}px` });
  }

  focus(id: string): void {
    this.focusWindow(id);
  }

  close(id: string): void {
    void this.closeWindow(id);
  }

  minimize(id: string): void {
    void this.minimizeWindow(id);
  }

  zoom(id: string): void {
    this.windows.get(id)?.toggleZoom();
  }

  boundsChanged(win: DesktopWindow): void {
    if (!win.state.maximized && !compactMode()) this.settings.rememberBounds(win.state.appId, win.bounds());
    win.appInstance?.onResize?.();
  }

  // ─── Lifecycle ───

  createWindow(def: AppDefinition, instance: AppInstance, opts?: Partial<WindowState>): DesktopWindow {
    const id = `win-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const a = this.area();
    const size = def.size ?? { width: 760, height: 500 };
    const remembered = this.settings.boundsFor(def.id);
    let width = Math.min(opts?.width ?? remembered?.width ?? size.width, a.width - 20);
    let height = Math.min(opts?.height ?? remembered?.height ?? size.height, a.height - 10);
    const sameApp = this.getWindowsByApp(def.id).length;
    let x = opts?.x ?? (remembered ? remembered.x + sameApp * CASCADE : Math.round((a.width - width) / 2) + (this.cascade % 6) * CASCADE - 60);
    let y = opts?.y ?? (remembered ? remembered.y + sameApp * CASCADE : a.y + Math.max(10, Math.round((a.height - height) / 3)) + (this.cascade % 6) * CASCADE);
    this.cascade++;
    x = Math.min(Math.max(a.x, x), a.x + a.width - width);
    y = Math.min(Math.max(a.y, y), a.y + a.height - height);
    if (compactMode()) ({ x, y, width, height } = a);

    const state: WindowState = { id, appId: def.id, title: instance.getTitle(), x, y, width, height, minimized: false, maximized: compactMode(), zIndex: ++this.z };
    const win = new DesktopWindow(state, this, def.chrome ?? 'standard', def.minSize ?? { width: 320, height: 200 });
    win.appInstance = instance;
    this.windows.set(id, win);
    this.layer.append(win.el);
    instance.mount(win.contentEl, win);
    this.focusWindow(id);
    this.bus.emit('window:open', { windowId: id, appId: def.id });
    return win;
  }

  setTitle(id: string, title: string): void {
    const win = this.windows.get(id);
    if (!win) return;
    win.setTitle(title);
    this.bus.emit('window:title', { windowId: id, title });
  }

  focusWindow(id: string): void {
    const win = this.windows.get(id);
    if (!win) return;
    if (win.state.minimized) {
      win.restore();
      this.bus.emit('window:restore', { windowId: id, appId: win.state.appId });
    }
    if (this.focusedId === id && win.el.classList.contains('focused')) {
      if (win.state.zIndex !== this.z) win.setZIndex(++this.z);
      return;
    }
    if (this.focusedId) this.windows.get(this.focusedId)?.setFocused(false);
    win.setZIndex(++this.z);
    win.setFocused(true);
    this.focusedId = id;
    win.appInstance?.focus?.();
    this.bus.emit('window:focus', { windowId: id, appId: win.state.appId });
  }

  /** Bring every window of an app forward (Dock click, app switcher). */
  activateApp(appId: string): boolean {
    const wins = this.getWindowsByApp(appId).sort((a, b) => a.state.zIndex - b.state.zIndex);
    if (!wins.length) return false;
    const visible = wins.filter((w) => !w.state.minimized);
    if (!visible.length) {
      this.focusWindow(wins[wins.length - 1].state.id);
      return true;
    }
    for (const w of visible) w.setZIndex(++this.z);
    this.focusWindow(visible[visible.length - 1].state.id);
    return true;
  }

  async closeWindow(id: string, force = false): Promise<boolean> {
    const win = this.windows.get(id);
    if (!win) return true;
    if (!force && win.appInstance?.canClose) {
      this.focusWindow(id);
      if (!(await win.appInstance.canClose())) return false;
    }
    this.windows.delete(id);
    await win.animateClose();
    win.appInstance?.unmount();
    win.el.remove();
    this.bus.emit('window:close', { windowId: id, appId: win.state.appId });
    if (this.focusedId === id) {
      this.focusedId = null;
      const top = this.topWindow();
      if (top) this.focusWindow(top.state.id);
      else this.bus.emit('desktop:focus', {});
    }
    return true;
  }

  async quitApp(appId: string): Promise<void> {
    for (const w of this.getWindowsByApp(appId)) {
      if (!(await this.closeWindow(w.state.id))) return;
    }
  }

  async minimizeWindow(id: string): Promise<void> {
    const win = this.windows.get(id);
    if (!win || win.state.minimized) return;
    if (this.focusedId === id) {
      win.setFocused(false);
      this.focusedId = null;
    }
    this.bus.emit('window:minimize', { windowId: id, appId: win.state.appId });
    await win.minimize();
    if (!this.focusedId) {
      const top = this.topWindow();
      if (top) this.focusWindow(top.state.id);
      else this.bus.emit('desktop:focus', {});
    }
  }

  /** Clicking the desktop: no window is focused (the menu bar shows Finder's menus). */
  blurAll(): void {
    if (this.focusedId) this.windows.get(this.focusedId)?.setFocused(false);
    this.focusedId = null;
    this.bus.emit('desktop:focus', {});
  }

  getWindow(id: string): DesktopWindow | undefined {
    return this.windows.get(id);
  }

  getFocusedWindow(): DesktopWindow | undefined {
    return this.focusedId ? this.windows.get(this.focusedId) : undefined;
  }

  getWindowsByApp(appId: string): DesktopWindow[] {
    return [...this.windows.values()].filter((w) => w.state.appId === appId);
  }

  getAllWindows(): DesktopWindow[] {
    return [...this.windows.values()];
  }

  /** App ids with at least one window, most recently used first. */
  runningApps(): string[] {
    const best = new Map<string, number>();
    for (const w of this.windows.values()) best.set(w.state.appId, Math.max(best.get(w.state.appId) ?? 0, w.state.zIndex));
    return [...best.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
  }

  private topWindow(): DesktopWindow | undefined {
    let top: DesktopWindow | undefined;
    for (const w of this.windows.values()) {
      if (!w.state.minimized && (!top || w.state.zIndex > top.state.zIndex)) top = w;
    }
    return top;
  }

  // ─── Show all windows (Mission Control-lite) ───

  get overviewActive(): boolean {
    return this.overviewOn;
  }

  toggleOverview(): void {
    if (this.overviewOn) return this.exitOverview();
    const wins = this.getAllWindows().filter((w) => !w.state.minimized);
    if (!wins.length) return;
    this.overviewOn = true;
    document.body.classList.add('lf-overview');
    const a = this.area();
    const cols = Math.ceil(Math.sqrt(wins.length));
    const rows = Math.ceil(wins.length / cols);
    const cellW = (a.width - 80) / cols;
    const cellH = (a.height - 60) / rows;
    wins.forEach((w, i) => {
      const col = i % cols;
      const row = Math.floor(i / cols);
      const s = Math.min(1, (cellW - 40) / w.state.width, (cellH - 50) / w.state.height);
      const cx = a.x + 40 + col * cellW + cellW / 2;
      const cy = a.y + 30 + row * cellH + cellH / 2;
      const dx = cx - (w.state.x + w.state.width / 2);
      const dy = cy - (w.state.y + w.state.height / 2);
      w.el.classList.add('overview');
      w.el.style.transition = reducedMotion() ? 'none' : 'transform 260ms cubic-bezier(.2,.8,.2,1)';
      w.el.style.transform = `translate(${dx}px, ${dy}px) scale(${s})`;
      w.el.dataset.label = w.state.title;
      const pick = (e: Event) => {
        e.stopPropagation();
        e.preventDefault();
        this.exitOverview();
        this.focusWindow(w.state.id);
      };
      w.el.addEventListener('click', pick, { capture: true, once: true });
      (w.el as HTMLElement & { _pick?: (e: Event) => void })._pick = pick;
    });
  }

  exitOverview(): void {
    if (!this.overviewOn) return;
    this.overviewOn = false;
    document.body.classList.remove('lf-overview');
    for (const w of this.windows.values()) {
      const el = w.el as HTMLElement & { _pick?: (e: Event) => void };
      if (el._pick) el.removeEventListener('click', el._pick, { capture: true });
      el._pick = undefined;
      el.classList.remove('overview');
      el.style.transform = '';
      setTimeout(() => (el.style.transition = ''), 280);
    }
  }
}
