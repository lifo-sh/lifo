// Finder: browse the box's files. A sidebar of places, icon and list views, back/forward, search
// in the folder, drag and drop to move files (or onto the Dock's Trash), right-click menus, and
// the Trash with Put Back. It updates live as files change, from any app or Terminal.

import type { AppDefinition, AppContext, AppInstance, MenuCategory } from '../../types';
import type { DesktopWindow } from '../../core/Window';
import { APP_ICONS, FOLDER_ICON, DISK_ICON, GLYPHS, fileIcon, trashIcon } from '../../icons';
import { h, svg, showContextMenu, promptDialog, type MenuEntry } from '../../core/ui';
import { HOME, TRASH, basename, dirname, joinPath, formatBytes } from '../../core/box';
import { DRAG_MIME } from '../../core/Dock';

type View = 'icons' | 'list';
interface Entry {
  name: string;
  path: string;
  dir: boolean;
  size: number;
  mtime: number;
}

const PLACES = [
  { label: 'Home', path: HOME, glyph: GLYPHS.home },
  { label: 'Desktop', path: `${HOME}/Desktop`, glyph: GLYPHS.desktop },
  { label: 'Documents', path: `${HOME}/Documents`, glyph: GLYPHS.doc },
  { label: 'Downloads', path: `${HOME}/Downloads`, glyph: GLYPHS.download },
  { label: 'Projects', path: `${HOME}/Projects`, glyph: GLYPHS.code },
];
const LOCATIONS = [
  { label: 'Lifo HD', path: '/', glyph: GLYPHS.drive },
  { label: 'tmp', path: '/tmp', glyph: GLYPHS.folder },
];

function readView(): View {
  try {
    return (localStorage.getItem('lifo-desktop:finder-view') as View) || 'icons';
  } catch {
    return 'icons';
  }
}

class FinderInstance implements AppInstance {
  readonly appId = 'finder';
  private win!: DesktopWindow;
  private path: string;
  private back: string[] = [];
  private fwd: string[] = [];
  private view: View = readView();
  private showHidden = false;
  private filter = '';
  private selection = new Set<string>();
  private anchor: string | null = null;
  private entries: Entry[] = [];
  private unwatch: (() => void) | null = null;
  private els!: { sidebar: HTMLElement; title: HTMLElement; body: HTMLElement; status: HTMLElement; backBtn: HTMLButtonElement; fwdBtn: HTMLButtonElement; viewBtns: HTMLElement; search: HTMLInputElement; trashBtn: HTMLElement };
  private offTrash: (() => void) | null = null;

  constructor(private ctx: AppContext, arg?: string) {
    const vfs = ctx.box.vfs;
    let start = arg && vfs.exists(arg) ? arg : HOME;
    if (vfs.exists(start) && vfs.stat(start).type !== 'directory') {
      this.selection.add(start);
      start = dirname(start);
    }
    this.path = start;
  }

  mount(container: HTMLElement, win: DesktopWindow): void {
    this.win = win;
    const btn = (glyph: string, title: string, onclick: () => void) => h('button', { class: 'lf-tb-btn', title, 'aria-label': title, onclick }, svg(glyph));
    const backBtn = btn(GLYPHS.back, 'Back', () => this.goBack()) as HTMLButtonElement;
    const fwdBtn = btn(GLYPHS.forward, 'Forward', () => this.goForward()) as HTMLButtonElement;
    const viewBtns = h('div', { class: 'lf-segmented', 'data-nodrag': '' }, btn(GLYPHS.grid, 'View as Icons', () => this.setView('icons')), btn(GLYPHS.list, 'View as List', () => this.setView('list')));
    const search = h('input', { class: 'lf-search', placeholder: 'Search', 'aria-label': 'Search this folder', spellcheck: 'false' }) as HTMLInputElement;
    search.addEventListener('input', () => {
      this.filter = search.value.trim().toLowerCase();
      this.renderBody();
    });
    const trashBtn = h('button', { class: 'lf-btn small', onclick: () => void this.ctx.files.emptyTrash() }, 'Empty');
    const title = h('div', { class: 'lf-toolbar-title' });
    const toolbar = h(
      'div',
      { class: 'lf-toolbar', 'data-drag': '' },
      h('div', { class: 'lf-tb-group' }, backBtn, fwdBtn),
      title,
      h('div', { class: 'lf-tb-spacer' }),
      trashBtn,
      viewBtns,
      btn(GLYPHS.folderPlus, 'New Folder', () => void this.newFolder()),
      h('div', { class: 'lf-search-wrap' }, svg(GLYPHS.search), search),
    );
    const sidebar = h('div', { class: 'lf-sidebar', 'data-drag': '' });
    const body = h('div', { class: 'lf-finder-body', tabindex: 0 });
    const status = h('div', { class: 'lf-statusbar' });
    container.append(h('div', { class: 'lf-finder' }, sidebar, h('div', { class: 'lf-finder-main' }, toolbar, body, status)));
    this.els = { sidebar, title, body, status, backBtn, fwdBtn, viewBtns, search, trashBtn };

    body.addEventListener('pointerdown', (e) => {
      if (e.target === body || (e.target as HTMLElement).classList.contains('lf-grid') || (e.target as HTMLElement).classList.contains('lf-list-body')) this.select([]);
    });
    body.addEventListener('contextmenu', (e) => {
      if ((e.target as HTMLElement).closest('[data-path]')) return;
      e.preventDefault();
      showContextMenu(this.folderMenu(), e.clientX, e.clientY);
    });
    body.addEventListener('keydown', (e) => this.onKey(e));
    this.dropTarget(body, () => this.path);
    this.offTrash = this.ctx.eventBus.on('trash:change', () => this.renderSidebar());

    this.renderSidebar();
    this.navigate(this.path, false);
  }

  unmount(): void {
    this.unwatch?.();
    this.offTrash?.();
  }

  focus(): void {
    this.els?.body.focus({ preventScroll: true });
  }

  getTitle(): string {
    return this.path === TRASH ? 'Trash' : this.path === '/' ? 'Lifo HD' : basename(this.path);
  }

  // ─── Navigation ───

  navigate(path: string, push = true): void {
    const vfs = this.ctx.box.vfs;
    if (!vfs.exists(path)) path = HOME;
    if (push && path !== this.path) {
      this.back.push(this.path);
      this.fwd = [];
    }
    if (path !== this.path) this.selection.clear();
    this.path = path;
    this.filter = '';
    if (this.els) this.els.search.value = '';
    this.unwatch?.();
    let pending = 0;
    this.unwatch = vfs.watch(path, (ev) => {
      if (dirname(ev.path) !== this.path && ev.path !== this.path && dirname(ev.oldPath ?? '') !== this.path) return;
      cancelAnimationFrame(pending);
      pending = requestAnimationFrame(() => this.load());
    });
    this.load();
    this.ctx.windowManager.setTitle(this.win.state.id, this.getTitle());
    this.renderSidebar();
  }

  private goBack(): void {
    const p = this.back.pop();
    if (!p) return;
    this.fwd.push(this.path);
    this.navigate(p, false);
  }

  private goForward(): void {
    const p = this.fwd.pop();
    if (!p) return;
    this.back.push(this.path);
    this.navigate(p, false);
  }

  private setView(v: View): void {
    this.view = v;
    try {
      localStorage.setItem('lifo-desktop:finder-view', v);
    } catch {
      /* fine */
    }
    this.renderBody();
  }

  private load(): void {
    const vfs = this.ctx.box.vfs;
    try {
      this.entries = vfs
        .readdirStat(this.path)
        .filter((e) => !(this.path === '/' && (e.name === 'proc' || e.name === 'dev')))
        .map((e) => ({ name: e.name, path: joinPath(this.path, e.name), dir: e.type === 'directory', size: e.size, mtime: e.mtime }))
        .sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name, undefined, { numeric: true }) : a.dir ? -1 : 1));
    } catch {
      this.entries = [];
    }
    for (const p of [...this.selection]) if (!this.entries.some((e) => e.path === p)) this.selection.delete(p);
    this.renderBody();
  }

  private visible(): Entry[] {
    return this.entries.filter((e) => (this.showHidden || !e.name.startsWith('.')) && (!this.filter || e.name.toLowerCase().includes(this.filter)));
  }

  // ─── Rendering ───

  private renderSidebar(): void {
    const { sidebar } = this.els;
    const item = (label: string, path: string, glyph: string) => {
      const el = h('div', { class: `lf-sidebar-item${this.path === path ? ' active' : ''}`, 'data-nodrag': '' }, svg(glyph), h('span', {}, label));
      el.addEventListener('click', () => this.navigate(path));
      this.dropTarget(el, () => path);
      return el;
    };
    const trashFull = this.ctx.files.trashCount() > 0;
    sidebar.replaceChildren(
      h('div', { class: 'lf-sidebar-spacer' }),
      h('div', { class: 'lf-sidebar-heading' }, 'Favorites'),
      ...PLACES.filter((p) => this.ctx.box.vfs.exists(p.path)).map((p) => item(p.label, p.path, p.glyph)),
      h('div', { class: 'lf-sidebar-heading' }, 'Locations'),
      ...LOCATIONS.map((p) => item(p.label, p.path, p.glyph)),
      item('Trash', TRASH, GLYPHS.trash),
    );
    this.els.trashBtn.style.display = this.path === TRASH ? '' : 'none';
    (this.els.trashBtn as HTMLButtonElement).disabled = !trashFull;
  }

  private renderBody(): void {
    const { body, title, status, backBtn, fwdBtn, viewBtns } = this.els;
    title.textContent = this.getTitle();
    backBtn.disabled = !this.back.length;
    fwdBtn.disabled = !this.fwd.length;
    viewBtns.children[0].classList.toggle('active', this.view === 'icons');
    viewBtns.children[1].classList.toggle('active', this.view === 'list');
    const list = this.visible();
    const scroll = body.scrollTop;
    body.replaceChildren(this.view === 'icons' ? this.iconGrid(list) : this.listView(list));
    body.scrollTop = scroll;
    if (!list.length) body.append(h('div', { class: 'lf-empty' }, this.filter ? 'No matches' : this.path === TRASH ? 'Trash is empty' : 'This folder is empty'));
    const sel = this.selection.size;
    status.textContent = `${list.length} item${list.length === 1 ? '' : 's'}${sel ? `, ${sel} selected` : ''}`;
  }

  private iconFor(e: Entry): string {
    if (e.path === '/') return DISK_ICON;
    if (e.path === TRASH) return trashIcon(this.ctx.files.trashCount() > 0);
    if (e.dir) return FOLDER_ICON;
    if (/\.(app)$/.test(e.name)) return APP_ICONS.about;
    return fileIcon(e.name);
  }

  private iconGrid(list: Entry[]): HTMLElement {
    const grid = h('div', { class: 'lf-grid' });
    for (const e of list) {
      const el = h(
        'div',
        { class: `lf-grid-item${this.selection.has(e.path) ? ' selected' : ''}`, 'data-path': e.path, draggable: 'true', title: e.name },
        h('div', { class: 'lf-grid-icon', html: this.iconFor(e) }),
        h('div', { class: 'lf-grid-name' }, e.name),
      );
      this.wireItem(el, e);
      grid.append(el);
    }
    return grid;
  }

  private listView(list: Entry[]): HTMLElement {
    const table = h('div', { class: 'lf-list' }, h('div', { class: 'lf-list-head' }, h('span', {}, 'Name'), h('span', {}, 'Date Modified'), h('span', {}, 'Size'), h('span', {}, 'Kind')));
    const bodyEl = h('div', { class: 'lf-list-body' });
    for (const e of list) {
      const kind = e.dir ? 'Folder' : e.name.includes('.') ? `${e.name.split('.').pop()!.toUpperCase()} file` : 'Document';
      const el = h(
        'div',
        { class: `lf-list-row${this.selection.has(e.path) ? ' selected' : ''}`, 'data-path': e.path, draggable: 'true' },
        h('span', { class: 'lf-list-name' }, h('span', { class: 'lf-list-icon', html: this.iconFor(e) }), e.name),
        h('span', {}, new Date(e.mtime).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })),
        h('span', {}, e.dir ? '--' : formatBytes(e.size)),
        h('span', {}, kind),
      );
      this.wireItem(el, e);
      bodyEl.append(el);
    }
    table.append(bodyEl);
    return table;
  }

  private wireItem(el: HTMLElement, e: Entry): void {
    el.addEventListener('pointerdown', (ev) => {
      if (ev.button === 2 && this.selection.has(e.path)) return;
      if (ev.metaKey || ev.ctrlKey) {
        const next = new Set(this.selection);
        if (next.has(e.path)) next.delete(e.path);
        else next.add(e.path);
        this.select([...next]);
      } else if (ev.shiftKey && this.anchor) {
        const vis = this.visible().map((x) => x.path);
        const [a, b] = [vis.indexOf(this.anchor), vis.indexOf(e.path)].sort((x, y) => x - y);
        this.select(vis.slice(a, b + 1), false);
      } else if (!this.selection.has(e.path)) this.select([e.path]);
    });
    el.addEventListener('dblclick', () => this.openEntry(e));
    el.addEventListener('dragstart', (ev) => {
      const paths = this.selection.has(e.path) ? [...this.selection] : [e.path];
      ev.dataTransfer?.setData(DRAG_MIME, JSON.stringify(paths));
      ev.dataTransfer?.setData('text/plain', paths.join('\n'));
      if (ev.dataTransfer) ev.dataTransfer.effectAllowed = 'move';
    });
    if (e.dir) this.dropTarget(el, () => e.path);
    el.addEventListener('contextmenu', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      if (!this.selection.has(e.path)) this.select([e.path]);
      showContextMenu(this.itemMenu(e), ev.clientX, ev.clientY);
    });
  }

  private select(paths: string[], setAnchor = true): void {
    this.selection = new Set(paths);
    if (setAnchor) this.anchor = paths[paths.length - 1] ?? null;
    for (const el of this.els.body.querySelectorAll<HTMLElement>('[data-path]')) el.classList.toggle('selected', this.selection.has(el.dataset.path!));
    const n = this.visible().length;
    this.els.status.textContent = `${n} item${n === 1 ? '' : 's'}${paths.length ? `, ${paths.length} selected` : ''}`;
  }

  private dropTarget(el: HTMLElement, dir: () => string): void {
    el.addEventListener('dragover', (e) => {
      if (!e.dataTransfer?.types.includes(DRAG_MIME)) return;
      e.preventDefault();
      e.stopPropagation();
      el.classList.add('drop');
    });
    el.addEventListener('dragleave', () => el.classList.remove('drop'));
    el.addEventListener('drop', (e) => {
      el.classList.remove('drop');
      const raw = e.dataTransfer?.getData(DRAG_MIME);
      if (!raw) return;
      e.preventDefault();
      e.stopPropagation();
      const target = dir();
      const paths: string[] = JSON.parse(raw);
      if (target === TRASH) this.ctx.files.moveToTrash(paths);
      else this.ctx.files.move(paths, target);
    });
  }

  private openEntry(e: Entry): void {
    if (e.dir) this.navigate(e.path);
    else this.ctx.open(e.path);
  }

  private onKey(e: KeyboardEvent): void {
    const vis = this.visible();
    const sel = [...this.selection];
    if (e.key === 'Enter' && sel.length === 1) {
      const entry = vis.find((x) => x.path === sel[0]);
      if (entry) this.openEntry(entry);
    } else if ((e.key === 'Backspace' || e.key === 'Delete') && (e.metaKey || e.ctrlKey || e.key === 'Delete') && sel.length) {
      e.preventDefault();
      this.ctx.files.moveToTrash(sel);
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      const i = vis.findIndex((x) => x.path === sel[sel.length - 1]);
      const cols = this.view === 'icons' ? Math.max(1, Math.floor(this.els.body.clientWidth / 104)) : 1;
      const step = e.key === 'ArrowDown' ? cols : e.key === 'ArrowUp' ? -cols : e.key === 'ArrowRight' ? 1 : -1;
      const next = vis[Math.min(vis.length - 1, Math.max(0, i < 0 ? 0 : i + step))];
      if (next) {
        this.select([next.path]);
        this.els.body.querySelector(`[data-path="${CSS.escape(next.path)}"]`)?.scrollIntoView({ block: 'nearest' });
      }
    } else if ((e.metaKey || e.ctrlKey) && e.key === 'a') {
      e.preventDefault();
      this.select(vis.map((x) => x.path));
    } else if (e.key === 'Backspace' && !sel.length) this.goBack();
  }

  // ─── Actions and menus ───

  private async newFolder(): Promise<void> {
    if (this.path === TRASH) return;
    const p = await this.ctx.files.newFolder(this.path);
    if (p) this.select([p]);
  }

  private itemMenu(e: Entry): MenuEntry[] {
    const files = this.ctx.files;
    const sel = this.selection.has(e.path) ? [...this.selection] : [e.path];
    if (files.isInTrash(e.path)) {
      return [
        { label: 'Put Back', action: () => sel.forEach((p) => files.putBack(p)) },
        { label: 'Get Info', action: () => files.getInfo(e.path) },
        { separator: true, label: '' },
        { label: 'Empty Trash', action: () => void files.emptyTrash() },
      ];
    }
    const openWith = e.dir ? [] : this.ctx.appRegistry.appsForFile(e.path).map((a) => ({ label: a.name, action: () => this.ctx.launch(a.id, e.path) }));
    return [
      { label: 'Open', action: () => this.openEntry(e) },
      ...(openWith.length ? [{ label: 'Open With', submenu: openWith }] : []),
      { label: e.dir ? 'Open in Terminal' : 'Open Folder in Terminal', action: () => this.ctx.launch('terminal', e.dir ? e.path : this.path) },
      { separator: true, label: '' },
      { label: 'Get Info', action: () => files.getInfo(e.path) },
      { label: 'Rename', disabled: sel.length > 1, action: () => void files.rename(e.path) },
      { label: 'Duplicate', action: () => sel.forEach((p) => files.duplicate(p)) },
      { label: 'Copy Path', action: () => void navigator.clipboard?.writeText(sel.join('\n')) },
      { separator: true, label: '' },
      { label: sel.length > 1 ? `Move ${sel.length} Items to Trash` : 'Move to Trash', action: () => files.moveToTrash(sel) },
    ];
  }

  private folderMenu(): MenuEntry[] {
    if (this.path === TRASH) return [{ label: 'Empty Trash', disabled: !this.ctx.files.trashCount(), action: () => void this.ctx.files.emptyTrash() }];
    return [
      { label: 'New Folder', action: () => void this.newFolder() },
      { label: 'New File', action: () => void this.ctx.files.newFile(this.path) },
      { separator: true, label: '' },
      { label: 'Open in Terminal', action: () => this.ctx.launch('terminal', this.path) },
      { label: 'Get Info', action: () => this.ctx.files.getInfo(this.path) },
      { separator: true, label: '' },
      { label: 'View as Icons', checked: this.view === 'icons', action: () => this.setView('icons') },
      { label: 'View as List', checked: this.view === 'list', action: () => this.setView('list') },
      { label: 'Show Hidden Files', checked: this.showHidden, action: () => this.toggleHidden() },
    ];
  }

  private toggleHidden(): void {
    this.showHidden = !this.showHidden;
    this.renderBody();
  }

  getMenus(): MenuCategory[] {
    const sel = [...this.selection];
    const go = (label: string, path: string, shortcut?: string) => ({ label, shortcut, action: () => this.navigate(path) });
    return [
      {
        label: 'File',
        items: [
          { label: 'New Finder Window', shortcut: '⌥N', action: () => this.ctx.launch('finder', this.path) },
          { label: 'New Folder', action: () => void this.newFolder() },
          { label: 'New File', action: () => void this.ctx.files.newFile(this.path) },
          { separator: true, label: '' },
          { label: 'Open', disabled: !sel.length, action: () => sel.forEach((p) => this.ctx.open(p)) },
          { label: 'Get Info', disabled: sel.length !== 1, action: () => this.ctx.files.getInfo(sel[0]) },
          { label: 'Rename', disabled: sel.length !== 1, action: () => void this.ctx.files.rename(sel[0]) },
          { label: 'Move to Trash', shortcut: '⌘⌫', disabled: !sel.length || this.path === TRASH, action: () => this.ctx.files.moveToTrash(sel) },
        ],
      },
      {
        label: 'View',
        items: [
          { label: 'as Icons', checked: this.view === 'icons', action: () => this.setView('icons') },
          { label: 'as List', checked: this.view === 'list', action: () => this.setView('list') },
          { separator: true, label: '' },
          { label: 'Show Hidden Files', checked: this.showHidden, action: () => this.toggleHidden() },
        ],
      },
      {
        label: 'Go',
        items: [
          { label: 'Back', disabled: !this.back.length, action: () => this.goBack() },
          { label: 'Forward', disabled: !this.fwd.length, action: () => this.goForward() },
          { label: 'Enclosing Folder', disabled: this.path === '/', action: () => this.navigate(dirname(this.path)) },
          { separator: true, label: '' },
          ...PLACES.map((p) => go(p.label, p.path)),
          go('Lifo HD', '/'),
          go('Trash', TRASH),
          { separator: true, label: '' },
          {
            label: 'Go to Folder…',
            action: async () => {
              const p = await promptDialog('Go to Folder', 'A path in the box, e.g. /etc or ~/Projects', this.path, 'Go');
              if (p) this.navigate(p.replace(/^~/, HOME));
            },
          },
        ],
      },
    ];
  }
}

export const finderDefinition: AppDefinition = {
  id: 'finder',
  name: 'Finder',
  icon: APP_ICONS.finder,
  chrome: 'unified',
  size: { width: 860, height: 520 },
  minSize: { width: 480, height: 280 },
  createInstance: (ctx, arg) => new FinderInstance(ctx, arg),
};
