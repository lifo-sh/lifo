// The desktop surface: the wallpaper, icons for the box's disk and the files in ~/Desktop, and
// its right-click menu. Clicking it unfocuses every window.

import { h, showContextMenu, type MenuEntry } from './ui';
import { DISK_ICON, FOLDER_ICON, fileIcon } from '../icons';
import { wallpaperCss, type Settings } from './settings';
import { HOME, joinPath } from './box';
import type { DesktopBox } from './box';
import type { FileOps } from './files';
import { DRAG_MIME } from './Dock';

const DESKTOP = `${HOME}/Desktop`;

export interface DesktopDeps {
  box: DesktopBox;
  settings: Settings;
  files: FileOps;
  open: (path: string) => void;
  launch: (appId: string, arg?: string) => void;
  blur: () => void;
}

export class Desktop {
  readonly el: HTMLElement;
  readonly windowLayer: HTMLElement;
  private wallpaper: HTMLElement;
  private iconsEl: HTMLElement;
  private selected = new Set<string>();

  constructor(root: HTMLElement, private d: DesktopDeps) {
    this.wallpaper = h('div', { class: 'lf-wallpaper' });
    this.iconsEl = h('div', { class: 'lf-desktop-icons' });
    this.windowLayer = h('div', { class: 'lf-window-layer' });
    this.el = h('div', { class: 'lf-desktop' }, this.wallpaper, this.iconsEl, this.windowLayer);
    root.append(this.el);

    const onSurface = (e: Event) => e.target === this.wallpaper || e.target === this.iconsEl || e.target === this.el;
    this.el.addEventListener('pointerdown', (e) => {
      if (!onSurface(e)) return;
      this.select([]);
      d.blur();
    });
    this.el.addEventListener('contextmenu', (e) => {
      if (!onSurface(e)) return;
      e.preventDefault();
      showContextMenu(this.surfaceMenu(), e.clientX, e.clientY);
    });
    this.el.addEventListener('dragover', (e) => {
      if (onSurface(e) && e.dataTransfer?.types.includes(DRAG_MIME)) e.preventDefault();
    });
    this.el.addEventListener('drop', (e) => {
      if (!onSurface(e)) return;
      const raw = e.dataTransfer?.getData(DRAG_MIME);
      if (!raw) return;
      e.preventDefault();
      d.files.move(JSON.parse(raw), DESKTOP);
    });

    d.settings.onChange(() => this.applySettings());
    d.box.vfs.watch(DESKTOP, () => this.renderIcons());
    this.applySettings();
    this.renderIcons();
  }

  private applySettings(): void {
    this.wallpaper.style.background = wallpaperCss(this.d.settings.get('wallpaper'));
    this.iconsEl.style.display = this.d.settings.get('showDesktopIcons') ? '' : 'none';
  }

  private select(paths: string[]): void {
    this.selected = new Set(paths);
    for (const el of this.iconsEl.querySelectorAll<HTMLElement>('.lf-desktop-icon')) el.classList.toggle('selected', this.selected.has(el.dataset.path!));
  }

  renderIcons(): void {
    const vfs = this.d.box.vfs;
    const entries: { path: string; name: string; icon: string; disk?: boolean }[] = [{ path: '/', name: 'Lifo HD', icon: DISK_ICON, disk: true }];
    try {
      for (const e of vfs.readdir(DESKTOP).filter((e) => !e.name.startsWith('.')).sort((a, b) => a.name.localeCompare(b.name))) {
        const path = joinPath(DESKTOP, e.name);
        entries.push({ path, name: e.name, icon: e.type === 'directory' ? FOLDER_ICON : fileIcon(e.name) });
      }
    } catch {
      /* no Desktop folder */
    }
    this.iconsEl.replaceChildren(
      ...entries.map((entry) => {
        const el = h(
          'div',
          { class: 'lf-desktop-icon', 'data-path': entry.path, draggable: entry.disk ? 'false' : 'true', tabindex: 0, title: entry.path },
          h('div', { class: 'lf-desktop-icon-img', html: entry.icon }),
          h('div', { class: 'lf-desktop-icon-name' }, entry.name),
        );
        el.addEventListener('pointerdown', (e) => {
          e.stopPropagation();
          this.select([entry.path]);
        });
        el.addEventListener('dblclick', () => this.d.open(entry.path));
        el.addEventListener('keydown', (e) => e.key === 'Enter' && this.d.open(entry.path));
        el.addEventListener('dragstart', (e) => {
          e.dataTransfer?.setData(DRAG_MIME, JSON.stringify([entry.path]));
          e.dataTransfer?.setData('text/plain', entry.path);
        });
        el.addEventListener('contextmenu', (e) => {
          e.preventDefault();
          e.stopPropagation();
          this.select([entry.path]);
          showContextMenu(this.iconMenu(entry.path, !!entry.disk), e.clientX, e.clientY);
        });
        return el;
      }),
    );
  }

  private surfaceMenu(): MenuEntry[] {
    const { files, launch } = this.d;
    return [
      { label: 'New Folder', action: () => void files.newFolder(DESKTOP) },
      { label: 'New File', action: () => void files.newFile(DESKTOP) },
      { separator: true, label: '' },
      { label: 'Open in Terminal', action: () => launch('terminal', DESKTOP) },
      { label: 'Open in Finder', action: () => launch('finder', DESKTOP) },
      { separator: true, label: '' },
      { label: 'Change Wallpaper…', action: () => launch('settings', 'wallpaper') },
      { label: this.d.settings.get('showDesktopIcons') ? 'Hide Desktop Icons' : 'Show Desktop Icons', action: () => this.d.settings.set('showDesktopIcons', !this.d.settings.get('showDesktopIcons')) },
    ];
  }

  private iconMenu(path: string, disk: boolean): MenuEntry[] {
    const { files, launch, open } = this.d;
    const items: MenuEntry[] = [
      { label: 'Open', action: () => open(path) },
      { label: 'Open in Terminal', action: () => launch('terminal', disk ? '/' : path) },
      { label: 'Get Info', action: () => files.getInfo(path) },
    ];
    if (!disk) {
      items.push(
        { separator: true, label: '' },
        { label: 'Rename', action: () => void files.rename(path) },
        { label: 'Duplicate', action: () => files.duplicate(path) },
        { label: 'Copy Path', action: () => void navigator.clipboard?.writeText(path) },
        { separator: true, label: '' },
        { label: 'Move to Trash', action: () => files.moveToTrash([path]) },
      );
    }
    return items;
  }
}
