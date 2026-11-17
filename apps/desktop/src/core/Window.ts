// One desktop window: traffic lights, a title bar (or an app-drawn unified toolbar), dragging with
// edge snapping, resizing from every edge and corner, minimize into the Dock and zoom.

import type { WindowState, AppInstance } from '../types';
import { h } from './ui';
import { reducedMotion } from './settings';

const RESIZE_DIRS = ['n', 's', 'e', 'w', 'nw', 'ne', 'sw', 'se'] as const;
export type Rect = { x: number; y: number; width: number; height: number };

export interface WindowHost {
  /** The usable desktop: below the menu bar, above the Dock. */
  area(): Rect;
  /** Where this window's app sits in the Dock (minimize target). */
  dockTarget(appId: string, windowId: string): DOMRect | null;
  snapPreview(rect: Rect | null): void;
  compact(): boolean;
  focus(id: string): void;
  close(id: string): void;
  minimize(id: string): void;
  zoom(id: string): void;
  boundsChanged(win: DesktopWindow): void;
}

export class DesktopWindow {
  readonly el: HTMLElement;
  readonly contentEl: HTMLElement;
  readonly titlebarEl: HTMLElement | null;
  appInstance: AppInstance | null = null;
  private titleEl: HTMLElement | null = null;
  private preZoom: Rect | null = null;

  constructor(
    readonly state: WindowState,
    private host: WindowHost,
    readonly chrome: 'standard' | 'unified',
    private minSize: { width: number; height: number },
  ) {
    const traffic = h(
      'div',
      { class: 'lf-traffic' },
      this.trafficBtn('close', 'Close', () => host.close(state.id)),
      this.trafficBtn('minimize', 'Minimize', () => host.minimize(state.id)),
      this.trafficBtn('zoom', 'Zoom', () => host.zoom(state.id)),
    );
    this.contentEl = h('div', { class: 'lf-win-content' });
    this.el = h('div', { class: `lf-win ${chrome}`, role: 'dialog', 'aria-label': state.title });

    if (chrome === 'standard') {
      this.titleEl = h('div', { class: 'lf-win-title' }, state.title);
      this.titlebarEl = h('div', { class: 'lf-win-titlebar', 'data-drag': '' }, traffic, this.titleEl);
      this.el.append(this.titlebarEl, this.contentEl);
    } else {
      this.titlebarEl = null;
      this.el.append(this.contentEl, traffic);
    }

    for (const dir of RESIZE_DIRS) {
      const handle = h('div', { class: `lf-resize ${dir}` });
      handle.addEventListener('pointerdown', (e) => this.startResize(e, dir));
      this.el.append(handle);
    }

    this.el.addEventListener('pointerdown', (e) => {
      host.focus(state.id);
      const dragEl = (e.target as HTMLElement).closest('[data-drag]');
      if (dragEl && this.el.contains(dragEl) && !(e.target as HTMLElement).closest('button, input, select, textarea, a, [data-nodrag], .lf-traffic')) {
        this.startDrag(e);
      }
    }, true);
    this.el.addEventListener('dblclick', (e) => {
      const t = e.target as HTMLElement;
      if (t.closest('[data-drag]') && !t.closest('button, input, select, textarea, [data-nodrag], .lf-traffic')) host.zoom(state.id);
    });

    this.applyBounds();
    this.setZIndex(state.zIndex);
    if (!reducedMotion()) {
      this.el.animate(
        [{ opacity: 0, transform: 'scale(0.94)' }, { opacity: 1, transform: 'scale(1)' }],
        { duration: 180, easing: 'cubic-bezier(.2,.8,.2,1)' },
      );
    }
  }

  private trafficBtn(kind: string, label: string, action: () => void): HTMLElement {
    return h('button', {
      class: `lf-traffic-btn ${kind}`,
      'aria-label': label,
      title: label,
      onclick: (e: Event) => {
        e.stopPropagation();
        action();
      },
    });
  }

  setTitle(title: string): void {
    this.state.title = title;
    if (this.titleEl) this.titleEl.textContent = title;
    this.el.setAttribute('aria-label', title);
  }

  setFocused(focused: boolean): void {
    this.el.classList.toggle('focused', focused);
  }

  setZIndex(z: number): void {
    this.state.zIndex = z;
    this.el.style.zIndex = String(z);
  }

  bounds(): Rect {
    return { x: this.state.x, y: this.state.y, width: this.state.width, height: this.state.height };
  }

  setBounds(r: Rect, animate = false): void {
    Object.assign(this.state, r);
    if (animate && !reducedMotion()) {
      this.el.classList.add('animating');
      setTimeout(() => this.el.classList.remove('animating'), 260);
    }
    this.applyBounds();
    this.appInstance?.onResize?.();
  }

  private applyBounds(): void {
    const s = this.el.style;
    s.left = `${this.state.x}px`;
    s.top = `${this.state.y}px`;
    s.width = `${this.state.width}px`;
    s.height = `${this.state.height}px`;
  }

  // ─── Zoom (green button): fill the desktop area, and back ───

  toggleZoom(): void {
    if (this.state.maximized) {
      this.state.maximized = false;
      this.el.classList.remove('maximized');
      this.setBounds(this.preZoom ?? this.host.area(), true);
      this.preZoom = null;
    } else {
      this.preZoom = this.bounds();
      this.state.maximized = true;
      this.el.classList.add('maximized');
      this.setBounds(this.host.area(), true);
    }
    this.host.boundsChanged(this);
  }

  fitToArea(): void {
    const a = this.host.area();
    if (this.state.maximized || this.host.compact()) {
      this.setBounds(a);
      return;
    }
    // Keep the title bar reachable after the viewport shrinks.
    const x = Math.min(Math.max(this.state.x, a.x - this.state.width + 80), a.x + a.width - 80);
    const y = Math.min(Math.max(this.state.y, a.y), a.y + a.height - 40);
    if (x !== this.state.x || y !== this.state.y) this.setBounds({ ...this.bounds(), x, y });
  }

  // ─── Minimize into the Dock, and back ───

  async minimize(): Promise<void> {
    this.state.minimized = true;
    const target = this.host.dockTarget(this.state.appId, this.state.id);
    if (target && !reducedMotion()) {
      const r = this.el.getBoundingClientRect();
      const dx = target.left + target.width / 2 - (r.left + r.width / 2);
      const dy = target.top + target.height / 2 - (r.top + r.height / 2);
      const sx = Math.max(0.04, target.width / r.width);
      const sy = Math.max(0.04, target.height / r.height);
      // A genie-ish fall: squeeze sideways first, then drop into the Dock.
      await this.el.animate(
        [
          { transform: 'none', opacity: 1, offset: 0 },
          { transform: `translate(${dx * 0.25}px, ${dy * 0.45}px) scale(${0.55 + sx * 0.45}, ${0.8})`, opacity: 0.95, offset: 0.45 },
          { transform: `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})`, opacity: 0.4, offset: 1 },
        ],
        { duration: 380, easing: 'cubic-bezier(.4,0,.2,1)' },
      ).finished.catch(() => {});
    }
    this.el.classList.add('minimized');
  }

  restore(): void {
    if (!this.state.minimized) return;
    this.state.minimized = false;
    const target = this.host.dockTarget(this.state.appId, this.state.id);
    this.el.classList.remove('minimized');
    if (target && !reducedMotion()) {
      const r = this.el.getBoundingClientRect();
      const dx = target.left + target.width / 2 - (r.left + r.width / 2);
      const dy = target.top + target.height / 2 - (r.top + r.height / 2);
      this.el.animate(
        [
          { transform: `translate(${dx}px, ${dy}px) scale(${Math.max(0.04, target.width / r.width)}, ${Math.max(0.04, target.height / r.height)})`, opacity: 0.4 },
          { transform: 'none', opacity: 1 },
        ],
        { duration: 300, easing: 'cubic-bezier(.2,.8,.2,1)' },
      );
    }
    this.appInstance?.onResize?.();
  }

  async animateClose(): Promise<void> {
    if (reducedMotion()) return;
    await this.el.animate([{ opacity: 1, transform: 'scale(1)' }, { opacity: 0, transform: 'scale(0.95)' }], {
      duration: 140,
      easing: 'ease-in',
    }).finished.catch(() => {});
  }

  // ─── Drag, with snapping to the left/right half or the full area ───

  private startDrag(e: PointerEvent): void {
    if (this.host.compact() || e.button !== 0) return;
    const start = { x: e.clientX, y: e.clientY };
    const orig = this.bounds();
    let moved = false;
    let snap: Rect | null = null;
    const target = e.target as HTMLElement;
    target.setPointerCapture?.(e.pointerId);

    const onMove = (ev: PointerEvent) => {
      const dx = ev.clientX - start.x;
      const dy = ev.clientY - start.y;
      if (!moved && Math.abs(dx) + Math.abs(dy) < 3) return;
      if (!moved) {
        moved = true;
        this.el.classList.add('dragging');
        // Dragging a zoomed window un-zooms it under the pointer, like macOS.
        if (this.state.maximized && this.preZoom) {
          this.state.maximized = false;
          this.el.classList.remove('maximized');
          const w = this.preZoom.width;
          orig.width = w;
          orig.height = this.preZoom.height;
          orig.x = start.x - w * ((start.x - orig.x) / this.state.width);
          this.preZoom = null;
        }
      }
      const a = this.host.area();
      const x = orig.x + dx;
      const y = Math.max(a.y, orig.y + dy);
      this.setBounds({ x, y, width: orig.width, height: orig.height });
      snap = null;
      if (ev.clientX <= a.x + 4) snap = { x: a.x, y: a.y, width: Math.round(a.width / 2), height: a.height };
      else if (ev.clientX >= a.x + a.width - 4) snap = { x: a.x + Math.round(a.width / 2), y: a.y, width: Math.round(a.width / 2), height: a.height };
      else if (ev.clientY <= a.y + 2) snap = a;
      this.host.snapPreview(snap);
    };
    const onUp = () => {
      target.removeEventListener('pointermove', onMove);
      target.removeEventListener('pointerup', onUp);
      target.removeEventListener('pointercancel', onUp);
      this.el.classList.remove('dragging');
      this.host.snapPreview(null);
      if (snap) {
        this.preZoom = orig;
        if (snap === this.host.area() || (snap.width === this.host.area().width)) {
          this.state.maximized = true;
          this.el.classList.add('maximized');
        }
        this.setBounds(snap, true);
      }
      if (moved) this.host.boundsChanged(this);
    };
    target.addEventListener('pointermove', onMove);
    target.addEventListener('pointerup', onUp);
    target.addEventListener('pointercancel', onUp);
  }

  private startResize(e: PointerEvent, dir: string): void {
    if (this.host.compact() || this.state.maximized) return;
    e.stopPropagation();
    e.preventDefault();
    this.host.focus(this.state.id);
    const handle = e.currentTarget as HTMLElement;
    handle.setPointerCapture(e.pointerId);
    const start = { x: e.clientX, y: e.clientY };
    const o = this.bounds();
    const { width: minW, height: minH } = this.minSize;
    const a = this.host.area();
    this.el.classList.add('resizing');

    const onMove = (ev: PointerEvent) => {
      const dx = ev.clientX - start.x;
      const dy = ev.clientY - start.y;
      let { x, y, width, height } = o;
      if (dir.includes('e')) width = Math.max(minW, o.width + dx);
      if (dir.includes('s')) height = Math.max(minH, o.height + dy);
      if (dir.includes('w')) {
        width = Math.max(minW, o.width - dx);
        x = o.x + o.width - width;
      }
      if (dir.includes('n')) {
        const top = Math.max(a.y, o.y + dy);
        height = Math.max(minH, o.y + o.height - top);
        y = o.y + o.height - height;
      }
      this.setBounds({ x, y, width, height });
    };
    const onUp = () => {
      handle.removeEventListener('pointermove', onMove);
      handle.removeEventListener('pointerup', onUp);
      this.el.classList.remove('resizing');
      this.host.boundsChanged(this);
    };
    handle.addEventListener('pointermove', onMove);
    handle.addEventListener('pointerup', onUp);
  }
}
