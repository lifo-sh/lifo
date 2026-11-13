// System Settings: appearance, wallpaper, Desktop & Dock, keyboard shortcuts, and about this box.
// Changes apply immediately and are remembered in this browser.

import type { AppDefinition, AppContext, AppInstance } from '../../types';
import type { DesktopWindow } from '../../core/Window';
import { APP_ICONS, GLYPHS, LIFO_MARK } from '../../icons';
import { h } from '../../core/ui';
import { WALLPAPERS, type Appearance } from '../../core/settings';
import { formatBytes, formatDuration } from '../../core/box';
import { SHORTCUTS } from '../../core/shortcuts';

type Pane = 'appearance' | 'wallpaper' | 'dock' | 'keyboard' | 'about';
const PANES: { id: Pane; label: string; glyph: string; color: string }[] = [
  { id: 'appearance', label: 'Appearance', glyph: GLYPHS.palette, color: '#6366f1' },
  { id: 'wallpaper', label: 'Wallpaper', glyph: GLYPHS.image, color: '#0ea5e9' },
  { id: 'dock', label: 'Desktop & Dock', glyph: GLYPHS.dock, color: '#111827' },
  { id: 'keyboard', label: 'Keyboard', glyph: GLYPHS.keyboard, color: '#6b7280' },
  { id: 'about', label: 'About', glyph: GLYPHS.info, color: '#16a34a' },
];

class SettingsInstance implements AppInstance {
  readonly appId = 'settings';
  private pane: Pane;
  private sidebar!: HTMLElement;
  private main!: HTMLElement;
  private off: (() => void) | null = null;

  constructor(private ctx: AppContext, arg?: string) {
    this.pane = (PANES.some((p) => p.id === arg) ? arg : 'appearance') as Pane;
  }

  mount(container: HTMLElement, _win: DesktopWindow): void {
    this.sidebar = h('div', { class: 'lf-sidebar', 'data-drag': '' });
    this.main = h('div', { class: 'lf-settings-main' });
    container.append(h('div', { class: 'lf-settings' }, this.sidebar, h('div', { class: 'lf-settings-right' }, h('div', { class: 'lf-toolbar', 'data-drag': '' }, h('div', { class: 'lf-toolbar-title' }, '')), this.main)));
    this.off = this.ctx.settings.onChange(() => this.render());
    this.render();
  }

  /** Opened again with a pane (e.g. "Change Wallpaper…"). */
  show(pane: string): void {
    if (PANES.some((p) => p.id === pane)) {
      this.pane = pane as Pane;
      this.render();
    }
  }

  private render(): void {
    this.sidebar.replaceChildren(
      h('div', { class: 'lf-sidebar-spacer' }),
      ...PANES.map((p) => {
        const el = h('div', { class: `lf-sidebar-item${this.pane === p.id ? ' active' : ''}`, 'data-nodrag': '' }, h('span', { class: 'lf-settings-badge', style: `background:${p.color}`, html: p.glyph }), h('span', {}, p.label));
        el.addEventListener('click', () => {
          this.pane = p.id;
          this.render();
        });
        return el;
      }),
    );
    const title = PANES.find((p) => p.id === this.pane)!.label;
    (this.main.previousElementSibling!.firstElementChild as HTMLElement).textContent = title;
    this.main.replaceChildren(this.paneContent());
  }

  private group(...rows: (Node | null)[]): HTMLElement {
    return h('div', { class: 'lf-group' }, ...rows);
  }

  private row(label: string, control: Node, hint = ''): HTMLElement {
    return h('div', { class: 'lf-row' }, h('div', { class: 'lf-row-label' }, label, hint ? h('small', {}, hint) : null), control);
  }

  private toggle(on: boolean, set: (v: boolean) => void): HTMLElement {
    const el = h('button', { class: `lf-switch${on ? ' on' : ''}`, role: 'switch', 'aria-checked': String(on), onclick: () => set(!on) }, h('span', {}));
    return el;
  }

  private slider(value: number, min: number, max: number, set: (v: number) => void): HTMLElement {
    const input = h('input', { type: 'range', min, max, value, class: 'lf-slider' }) as HTMLInputElement;
    input.addEventListener('input', () => set(Number(input.value)));
    return input;
  }

  private paneContent(): HTMLElement {
    const s = this.ctx.settings;
    switch (this.pane) {
      case 'appearance': {
        const opt = (value: Appearance, label: string, preview: string) =>
          h(
            'button',
            { class: `lf-appearance-opt${s.get('appearance') === value ? ' active' : ''}`, onclick: () => s.set('appearance', value) },
            h('div', { class: `lf-appearance-preview ${preview}` }, h('div', {}), h('div', {})),
            h('span', {}, label),
          );
        return h('div', {}, this.group(this.row('Appearance', h('div', { class: 'lf-appearance' }, opt('auto', 'Auto', 'auto'), opt('light', 'Light', 'light'), opt('dark', 'Dark', 'dark')))));
      }
      case 'wallpaper':
        return h(
          'div',
          {},
          h(
            'div',
            { class: 'lf-wallpapers' },
            ...WALLPAPERS.map((w) =>
              h(
                'button',
                { class: `lf-wallpaper-opt${s.get('wallpaper') === w.id ? ' active' : ''}`, onclick: () => s.set('wallpaper', w.id), title: w.name },
                h('div', { class: 'lf-wallpaper-thumb', style: `background:${w.css}` }),
                h('span', {}, w.name),
              ),
            ),
          ),
        );
      case 'dock':
        return h(
          'div',
          {},
          this.group(
            this.row('Size', this.slider(s.get('dockSize'), 36, 72, (v) => s.set('dockSize', v))),
            this.row('Magnification', this.toggle(s.get('magnification'), (v) => s.set('magnification', v))),
            this.row('Magnified size', this.slider(s.get('magnifiedSize'), 48, 128, (v) => s.set('magnifiedSize', v))),
          ),
          this.group(
            this.row('Show desktop icons', this.toggle(s.get('showDesktopIcons'), (v) => s.set('showDesktopIcons', v))),
            this.row('Window positions', h('button', { class: 'lf-btn small', onclick: () => s.resetLayout() }, 'Forget'), 'New windows open centered again'),
          ),
        );
      case 'keyboard':
        return h(
          'div',
          {},
          h('p', { class: 'lf-muted' }, 'Browsers keep ⌘W, ⌘Q, ⌘Tab and ⌘Space for themselves, so Lifo Desktop uses Option (⌥) for those.'),
          this.group(...SHORTCUTS.map(([keys, what]) => this.row(what, h('kbd', { class: 'lf-kbd' }, keys)))),
        );
      case 'about': {
        const box = this.ctx.box;
        const u = box.usage('/', 20000);
        return h(
          'div',
          { class: 'lf-about' },
          h('div', { class: 'lf-about-logo', html: LIFO_MARK }),
          h('h2', {}, 'Lifo'),
          h('p', { class: 'lf-muted' }, 'A Linux-like OS running in this browser tab'),
          this.group(
            this.row('Uptime', h('span', {}, formatDuration(Date.now() - box.bootedAt))),
            this.row('Processes', h('span', {}, String(box.processes.getAll().filter((p) => p.status !== 'zombie').length))),
            this.row('Files', h('span', {}, `${u.files.toLocaleString()}${u.partial ? '+' : ''} (${formatBytes(u.bytes)})`)),
            this.row('Storage', h('span', {}, 'IndexedDB in this browser')),
          ),
        );
      }
    }
  }

  unmount(): void {
    this.off?.();
  }

  getTitle(): string {
    return 'System Settings';
  }
}

export const settingsDefinition: AppDefinition = {
  id: 'settings',
  name: 'System Settings',
  icon: APP_ICONS.settings,
  chrome: 'unified',
  singleton: true,
  size: { width: 720, height: 500 },
  minSize: { width: 560, height: 360 },
  createInstance: (ctx, arg) => new SettingsInstance(ctx, arg),
};

export function showSettingsPane(inst: AppInstance | null, pane: string): void {
  if (inst instanceof SettingsInstance) inst.show(pane);
}
