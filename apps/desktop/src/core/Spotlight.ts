// Spotlight: search apps and files in the box, do quick math, or run a shell command in a new
// Terminal. ⌥Space (or Ctrl+Space, or the menu bar's magnifier) opens it.

import { h, svg, escapeHtml } from './ui';
import { GLYPHS, FOLDER_ICON, fileIcon } from '../icons';
import type { AppRegistry } from './AppRegistry';
import type { DesktopBox } from './box';
import { HOME } from './box';

interface Result {
  kind: 'app' | 'file' | 'command' | 'math';
  title: string;
  subtitle: string;
  icon: string;
  run: () => void;
}

export class Spotlight {
  private el: HTMLElement;
  private input: HTMLInputElement;
  private list: HTMLElement;
  private results: Result[] = [];
  private index = 0;
  private fileIndex: string[] | null = null;

  constructor(
    root: HTMLElement,
    private registry: AppRegistry,
    private box: DesktopBox,
    private launch: (appId: string, arg?: string) => void,
    private open: (path: string) => void,
  ) {
    this.input = h('input', { class: 'lf-spotlight-input', placeholder: 'Spotlight Search', spellcheck: 'false', 'aria-label': 'Spotlight Search' }) as HTMLInputElement;
    this.list = h('div', { class: 'lf-spotlight-results', role: 'listbox' });
    const panel = h('div', { class: 'lf-spotlight' }, h('div', { class: 'lf-spotlight-bar' }, svg(GLYPHS.search, 'lf-spotlight-glyph'), this.input), this.list);
    this.el = h('div', { class: 'lf-spotlight-layer' }, panel);
    this.el.addEventListener('pointerdown', (e) => e.target === this.el && this.hide());
    root.append(this.el);

    this.input.addEventListener('input', () => this.search());
    this.input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') this.hide();
      else if (e.key === 'ArrowDown') this.move(1, e);
      else if (e.key === 'ArrowUp') this.move(-1, e);
      else if (e.key === 'Enter') {
        e.preventDefault();
        const r = this.results[this.index];
        if (r) {
          this.hide();
          r.run();
        }
      }
    });
    box.vfs.watch(() => (this.fileIndex = null));
  }

  get visible(): boolean {
    return this.el.classList.contains('visible');
  }

  toggle(): void {
    if (this.visible) this.hide();
    else this.show();
  }

  show(): void {
    this.el.classList.add('visible');
    this.input.value = '';
    this.search();
    setTimeout(() => this.input.focus());
  }

  hide(): void {
    this.el.classList.remove('visible');
  }

  private move(d: number, e: Event): void {
    e.preventDefault();
    if (!this.results.length) return;
    this.index = (this.index + d + this.results.length) % this.results.length;
    this.paint();
  }

  private files(): string[] {
    if (this.fileIndex) return this.fileIndex;
    const out: string[] = [];
    const walk = (dir: string, depth: number) => {
      if (out.length > 4000 || depth > 8) return;
      let entries;
      try {
        entries = this.box.vfs.readdir(dir);
      } catch {
        return;
      }
      for (const e of entries) {
        if (e.name === 'node_modules' || e.name === '.git' || (e.name.startsWith('.') && e.name !== '.Trash')) continue;
        const p = `${dir}/${e.name}`;
        out.push(p);
        if (e.type === 'directory' && e.name !== '.Trash') walk(p, depth + 1);
      }
    };
    walk(HOME, 0);
    return (this.fileIndex = out);
  }

  private search(): void {
    const q = this.input.value.trim();
    const ql = q.toLowerCase();
    const results: Result[] = [];
    if (q && /^[\d\s+\-*/().%^]+$/.test(q) && /\d/.test(q)) {
      try {
        const value = Function(`"use strict"; return (${q.replace(/\^/g, '**')})`)();
        if (typeof value === 'number' && Number.isFinite(value)) {
          const text = String(Math.round(value * 1e10) / 1e10);
          results.push({ kind: 'math', title: `= ${text}`, subtitle: 'Copy to clipboard', icon: GLYPHS.code, run: () => void navigator.clipboard?.writeText(text) });
        }
      } catch {
        /* not an expression */
      }
    }
    const apps = this.registry.getAll().filter((a) => !a.hidden && (!q || a.name.toLowerCase().includes(ql)));
    for (const a of apps.slice(0, q ? 5 : 8)) results.push({ kind: 'app', title: a.name, subtitle: 'Application', icon: a.icon, run: () => this.launch(a.id) });
    if (q) {
      const matches = this.files()
        .filter((p) => p.split('/').pop()!.toLowerCase().includes(ql))
        .sort((a, b) => a.split('/').pop()!.length - b.split('/').pop()!.length)
        .slice(0, 8);
      for (const p of matches) {
        let isDir = false;
        try {
          isDir = this.box.vfs.stat(p).type === 'directory';
        } catch {
          /* gone */
        }
        results.push({ kind: 'file', title: p.split('/').pop()!, subtitle: p.replace(HOME, '~'), icon: isDir ? FOLDER_ICON : fileIcon(p), run: () => this.open(p) });
      }
      results.push({ kind: 'command', title: `Run “${q}” in Terminal`, subtitle: 'Opens a new Terminal window', icon: GLYPHS.terminal, run: () => this.launch('terminal', `run:${q}`) });
    }
    this.results = results;
    this.index = 0;
    this.paint();
  }

  private paint(): void {
    this.list.replaceChildren();
    let lastKind = '';
    const labels: Record<string, string> = { app: 'Applications', file: 'Files', command: 'Shell', math: 'Calculator' };
    this.results.forEach((r, i) => {
      if (r.kind !== lastKind) {
        this.list.append(h('div', { class: 'lf-spotlight-section' }, labels[r.kind]));
        lastKind = r.kind;
      }
      const row = h(
        'div',
        { class: `lf-spotlight-row${i === this.index ? ' active' : ''}`, role: 'option', 'aria-selected': String(i === this.index) },
        h('span', { class: `lf-spotlight-icon ${r.kind}`, html: r.icon }),
        h('span', { class: 'lf-spotlight-text', html: `<b>${escapeHtml(r.title)}</b><small>${escapeHtml(r.subtitle)}</small>` }),
      );
      row.addEventListener('pointermove', () => {
        if (this.index !== i) {
          this.index = i;
          this.paint();
        }
      });
      row.addEventListener('click', () => {
        this.hide();
        r.run();
      });
      this.list.append(row);
    });
    this.list.querySelector('.active')?.scrollIntoView({ block: 'nearest' });
    this.list.classList.toggle('empty', !this.results.length);
  }
}
