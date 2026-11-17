// Small DOM helpers shared by the shell and the apps: an element builder, context menus and
// modal dialogs (prompt, confirm, an info panel).

import type { MenuItem } from '../types';

type Attrs = Record<string, string | number | boolean | ((e: Event) => void) | undefined | null>;
type Child = Node | string | null | undefined | false;

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (typeof v === 'function') el.addEventListener(k.replace(/^on/, '').toLowerCase(), v as EventListener);
    else if (k === 'class') el.className = String(v);
    else if (k === 'html') el.innerHTML = String(v);
    else if (k === 'style') el.style.cssText = String(v);
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, String(v));
  }
  for (const c of children) if (c !== null && c !== undefined && c !== false) el.append(c);
  return el;
}

/** An inline SVG string as an element. */
export function svg(markup: string, cls = 'lf-glyph'): HTMLElement {
  return h('span', { class: cls, html: markup, 'aria-hidden': 'true' });
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

// ─── Menus (used by the menu bar, context menus and the dock) ───

export interface MenuEntry extends MenuItem {
  submenu?: MenuEntry[];
}

let openMenu: { el: HTMLElement; close: () => void } | null = null;

export function closeMenus(): void {
  openMenu?.close();
}

/** Render a menu panel. Returns the element; the caller positions it. */
export function renderMenu(items: MenuEntry[], onPick: () => void): HTMLElement {
  const panel = h('div', { class: 'lf-menu', role: 'menu' });
  for (const item of items) {
    if (item.separator) {
      panel.append(h('div', { class: 'lf-menu-sep', role: 'separator' }));
      continue;
    }
    const row = h(
      'div',
      { class: `lf-menu-item${item.disabled ? ' disabled' : ''}${item.submenu ? ' has-sub' : ''}`, role: 'menuitem', tabindex: -1 },
      h('span', { class: 'lf-menu-check' }, item.checked ? '✓' : ''),
      h('span', { class: 'lf-menu-label' }, item.label),
      item.shortcut ? h('span', { class: 'lf-menu-shortcut' }, item.shortcut) : null,
      item.submenu ? h('span', { class: 'lf-menu-arrow' }, '›') : null,
    );
    if (item.submenu) {
      const sub = renderMenu(item.submenu, onPick);
      sub.classList.add('lf-submenu');
      row.append(sub);
    } else if (!item.disabled) {
      row.addEventListener('click', (e) => {
        e.stopPropagation();
        onPick();
        // Let the menu close first so an action that opens a dialog gets focus.
        setTimeout(() => item.action?.(), 0);
      });
    }
    panel.append(row);
  }
  return panel;
}

/** A context menu at (x, y), kept on screen. */
export function showContextMenu(items: MenuEntry[], x: number, y: number): void {
  closeMenus();
  const layer = document.getElementById('lf-overlay') ?? document.body;
  const close = () => {
    panel.remove();
    document.removeEventListener('pointerdown', outside, true);
    document.removeEventListener('keydown', onKey, true);
    if (openMenu?.el === panel) openMenu = null;
  };
  const panel = renderMenu(items, close);
  panel.classList.add('lf-context');
  layer.append(panel);
  const r = panel.getBoundingClientRect();
  panel.style.left = `${Math.min(x, window.innerWidth - r.width - 6)}px`;
  panel.style.top = `${Math.min(y, window.innerHeight - r.height - 6)}px`;
  const outside = (e: Event) => {
    if (!panel.contains(e.target as Node)) close();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') close();
  };
  setTimeout(() => {
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('keydown', onKey, true);
  });
  openMenu = { el: panel, close };
}

/** Register the open menu-bar menu so context menus and it close each other. */
export function trackMenu(el: HTMLElement, close: () => void): void {
  if (openMenu && openMenu.el !== el) openMenu.close();
  openMenu = { el, close };
}

export function untrackMenu(el: HTMLElement): void {
  if (openMenu?.el === el) openMenu = null;
}

// ─── Dialogs ───

function modal(content: HTMLElement, onEscape: () => void): { close: () => void } {
  const layer = document.getElementById('lf-overlay') ?? document.body;
  const backdrop = h('div', { class: 'lf-modal-backdrop' });
  const box = h('div', { class: 'lf-modal', role: 'dialog', 'aria-modal': 'true' }, content);
  backdrop.append(box);
  layer.append(backdrop);
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      onEscape();
    }
  };
  document.addEventListener('keydown', onKey, true);
  return {
    close: () => {
      document.removeEventListener('keydown', onKey, true);
      backdrop.remove();
    },
  };
}

export function promptDialog(title: string, message: string, value = '', okLabel = 'OK'): Promise<string | null> {
  return new Promise((resolve) => {
    const input = h('input', { class: 'lf-input', value, spellcheck: 'false' }) as HTMLInputElement;
    const done = (v: string | null) => {
      m.close();
      resolve(v);
    };
    const form = h(
      'form',
      { class: 'lf-dialog', onsubmit: (e: Event) => (e.preventDefault(), done(input.value.trim() || null)) },
      h('div', { class: 'lf-dialog-title' }, title),
      message ? h('div', { class: 'lf-dialog-text' }, message) : null,
      input,
      h(
        'div',
        { class: 'lf-dialog-buttons' },
        h('button', { type: 'button', class: 'lf-btn', onclick: () => done(null) }, 'Cancel'),
        h('button', { type: 'submit', class: 'lf-btn primary' }, okLabel),
      ),
    );
    const m = modal(form, () => done(null));
    setTimeout(() => {
      input.focus();
      const dot = value.lastIndexOf('.');
      input.setSelectionRange(0, dot > 0 ? dot : value.length);
    });
  });
}

export function confirmDialog(title: string, message: string, okLabel = 'OK', danger = false): Promise<boolean> {
  return new Promise((resolve) => {
    const done = (v: boolean) => {
      m.close();
      resolve(v);
    };
    const ok = h('button', { type: 'button', class: `lf-btn primary${danger ? ' danger' : ''}`, onclick: () => done(true) }, okLabel);
    const content = h(
      'div',
      { class: 'lf-dialog' },
      h('div', { class: 'lf-dialog-title' }, title),
      h('div', { class: 'lf-dialog-text' }, message),
      h('div', { class: 'lf-dialog-buttons' }, h('button', { type: 'button', class: 'lf-btn', onclick: () => done(false) }, 'Cancel'), ok),
    );
    const m = modal(content, () => done(false));
    setTimeout(() => ok.focus());
  });
}

/** A panel with arbitrary content and a Done button (Get Info, About). */
export function infoDialog(title: string, body: HTMLElement): void {
  const content = h(
    'div',
    { class: 'lf-dialog wide' },
    h('div', { class: 'lf-dialog-title' }, title),
    body,
    h('div', { class: 'lf-dialog-buttons' }, h('button', { type: 'button', class: 'lf-btn primary', onclick: () => m.close() }, 'Done')),
  );
  const m = modal(content, () => m.close());
}

/** Trigger a browser download of `data` as `name`. */
export function download(name: string, data: Uint8Array | string, type = 'application/octet-stream'): void {
  const blob = new Blob([data as BlobPart], { type });
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

/** Ask for a file from the user's computer. */
export function pickFile(accept = ''): Promise<File | null> {
  return new Promise((resolve) => {
    const input = h('input', { type: 'file', accept, style: 'display:none' }) as HTMLInputElement;
    input.addEventListener('change', () => {
      resolve(input.files?.[0] ?? null);
      input.remove();
    });
    document.body.append(input);
    input.click();
  });
}

/** A dialog with several buttons; resolves to the index picked, or -1 on Escape. */
export function choiceDialog(title: string, message: string, buttons: { label: string; primary?: boolean; danger?: boolean }[]): Promise<number> {
  return new Promise((resolve) => {
    const done = (i: number) => {
      m.close();
      resolve(i);
    };
    const btns = buttons.map((b, i) =>
      h('button', { type: 'button', class: `lf-btn${b.primary ? ' primary' : ''}${b.danger ? ' danger' : ''}`, onclick: () => done(i) }, b.label),
    );
    const content = h(
      'div',
      { class: 'lf-dialog' },
      h('div', { class: 'lf-dialog-title' }, title),
      h('div', { class: 'lf-dialog-text' }, message),
      h('div', { class: 'lf-dialog-buttons' }, ...btns),
    );
    const m = modal(content, () => done(-1));
    setTimeout(() => (btns[buttons.findIndex((b) => b.primary)] ?? btns[0])?.focus());
  });
}
