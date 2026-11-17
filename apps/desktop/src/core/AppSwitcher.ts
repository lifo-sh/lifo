// App switcher: hold ⌥ (Option) and press Tab to cycle through running apps, release to switch.
// (Browsers keep ⌘Tab for the OS, so the desktop uses Option.)

import { h } from './ui';
import type { WindowManager } from './WindowManager';
import type { AppRegistry } from './AppRegistry';

export class AppSwitcher {
  private el: HTMLElement;
  private apps: string[] = [];
  private index = 0;

  constructor(root: HTMLElement, private wm: WindowManager, private registry: AppRegistry) {
    this.el = h('div', { class: 'lf-switcher', role: 'listbox', 'aria-label': 'Running apps' });
    root.append(this.el);
    window.addEventListener('keyup', (e) => {
      if ((e.key === 'Alt' || e.key === 'Meta') && this.active) this.commit();
    }, true);
    window.addEventListener('blur', () => this.active && this.cancel());
  }

  get active(): boolean {
    return this.el.classList.contains('visible');
  }

  /** Tab pressed with the modifier held. */
  next(back = false): void {
    if (!this.active) {
      this.apps = this.wm.runningApps();
      if (this.apps.length === 0) return;
      this.index = this.apps.length > 1 ? 1 : 0;
      this.el.classList.add('visible');
    } else {
      this.index = (this.index + (back ? -1 : 1) + this.apps.length) % this.apps.length;
    }
    this.paint();
  }

  cancel(): void {
    this.el.classList.remove('visible');
  }

  private commit(): void {
    const id = this.apps[this.index];
    this.cancel();
    if (id) this.wm.activateApp(id);
  }

  private paint(): void {
    this.el.replaceChildren(
      ...this.apps.map((id, i) => {
        const def = this.registry.get(id);
        const item = h('div', { class: `lf-switcher-item${i === this.index ? ' active' : ''}`, role: 'option' }, h('div', { class: 'lf-switcher-icon', html: def?.icon ?? '' }), h('div', { class: 'lf-switcher-name' }, def?.name ?? id));
        item.addEventListener('click', () => {
          this.index = i;
          this.commit();
        });
        return item;
      }),
    );
  }
}
