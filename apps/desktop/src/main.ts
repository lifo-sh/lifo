import '@xterm/xterm/css/xterm.css';
import './styles/theme.css';
import './styles/desktop.css';
import './styles/window.css';
import './styles/menubar.css';
import './styles/dock.css';
import './styles/spotlight.css';
import './styles/apps.css';

import { DesktopBox, HOME } from './core/box';
import { EventBus } from './core/EventBus';
import { AppRegistry } from './core/AppRegistry';
import { Desktop } from './core/Desktop';
import { WindowManager } from './core/WindowManager';
import { MenuBar, type MenuModel } from './core/MenuBar';
import { Dock } from './core/Dock';
import { Spotlight } from './core/Spotlight';
import { AppSwitcher } from './core/AppSwitcher';
import { FileOps } from './core/files';
import { Settings, WALLPAPERS } from './core/settings';
import { installShortcuts } from './core/shortcuts';
import { h, download, pickFile, confirmDialog, infoDialog, type MenuEntry } from './core/ui';
import { LIFO_MARK } from './icons';
import { registerBuiltinApps, PINNED } from './apps/index';
import { newTerminalTab } from './apps/terminal/TerminalApp';
import { showSettingsPane } from './apps/settings/SettingsApp';
import type { AppContext, MenuCategory } from './types';
import { finderDefinition } from './apps/finder/FinderApp';

async function boot() {
  const root = document.getElementById('desktop-root')!;
  const settings = new Settings();
  const applyTheme = () => {
    document.documentElement.dataset.theme = settings.theme();
  };
  applyTheme();
  settings.onChange(applyTheme);

  const splash = h('div', { class: 'lf-splash' }, h('div', { class: 'lf-splash-logo', html: LIFO_MARK }), h('div', { class: 'lf-splash-bar' }, h('div', { class: 'lf-splash-fill' })));
  root.append(splash);
  const progress = (p: number) => ((splash.querySelector('.lf-splash-fill') as HTMLElement).style.width = `${p}%`);
  progress(15);

  const box = await DesktopBox.create();
  progress(70);

  const bus = new EventBus();
  const registry = new AppRegistry();
  registerBuiltinApps(registry);
  const files = new FileOps(box, bus);
  const overlay = h('div', { id: 'lf-overlay' });

  // eslint-disable-next-line prefer-const
  let wm: WindowManager;
  const ctx: AppContext = {
    box,
    eventBus: bus,
    get windowManager() {
      return wm;
    },
    appRegistry: registry,
    settings,
    files,
    open(path: string) {
      if (!box.vfs.exists(path)) return;
      if (box.vfs.stat(path).type === 'directory') return void registry.launch('finder', ctx, path);
      const app = registry.appsForFile(path)[0];
      if (app) registry.launch(app.id, ctx, path);
    },
    launch(appId: string, arg?: string) {
      const existing = wm.getWindowsByApp(appId)[0];
      if (appId === 'settings' && existing && arg) {
        showSettingsPane(existing.appInstance, arg);
        wm.focusWindow(existing.state.id);
        return;
      }
      registry.launch(appId, ctx, arg);
    },
  };

  const desktop = new Desktop(root, { box, settings, files, open: (p) => ctx.open(p), launch: (id, arg) => ctx.launch(id, arg), blur: () => wm.blurAll() });
  wm = new WindowManager(bus, desktop.windowLayer, settings);

  const menuModel = (): MenuModel => {
    const focused = wm.getFocusedWindow();
    const appId = focused?.state.appId ?? 'finder';
    const def = registry.get(appId) ?? finderDefinition;
    const appMenus: MenuCategory[] = focused?.appInstance?.getMenus?.() ?? (focused ? [] : desktopFinderMenus());
    return {
      lifo: lifoMenu(),
      appName: def.name,
      appMenu: [
        { label: `About ${def.name}`, action: () => aboutApp(def.name, def.icon) },
        { separator: true, label: '' },
        { label: 'Settings…', shortcut: '⌥,', action: () => ctx.launch('settings') },
        { separator: true, label: '' },
        { label: `Hide ${def.name}`, disabled: !focused, action: () => wm.getWindowsByApp(appId).forEach((w) => void wm.minimizeWindow(w.state.id)) },
        { label: `Quit ${def.name}`, shortcut: '⌥Q', disabled: !wm.getWindowsByApp(appId).length, action: () => void wm.quitApp(appId) },
      ],
      categories: mergeMenus(appMenus, standardMenus(appId)),
    };
  };

  const lifoMenu = (): MenuEntry[] => [
    { label: 'About This Box', action: () => ctx.launch('about') },
    { separator: true, label: '' },
    { label: 'System Settings…', action: () => ctx.launch('settings') },
    { label: 'Activity Monitor', action: () => ctx.launch('activity') },
    { separator: true, label: '' },
    { label: 'Download Snapshot', action: () => void downloadSnapshot() },
    { label: 'Restore Snapshot…', action: () => void restoreSnapshot() },
    { separator: true, label: '' },
    { label: 'Show All Windows', shortcut: 'F3', action: () => wm.toggleOverview() },
    { label: 'Restart Box…', action: () => void restart() },
  ];

  const desktopFinderMenus = (): MenuCategory[] => [
    {
      label: 'File',
      items: [
        { label: 'New Finder Window', shortcut: '⌥N', action: () => ctx.launch('finder') },
        { label: 'New Folder on Desktop', action: () => void files.newFolder(`${HOME}/Desktop`) },
      ],
    },
    {
      label: 'Go',
      items: [
        { label: 'Home', action: () => ctx.launch('finder', HOME) },
        { label: 'Desktop', action: () => ctx.launch('finder', `${HOME}/Desktop`) },
        { label: 'Projects', action: () => ctx.launch('finder', `${HOME}/Projects`) },
        { label: 'Lifo HD', action: () => ctx.launch('finder', '/') },
        { label: 'Trash', action: () => ctx.launch('finder', `${HOME}/.Trash`) },
      ],
    },
  ];

  const editCommand = (cmd: string) => () => {
    if (cmd === 'paste') {
      void navigator.clipboard?.readText().then((t) => document.execCommand('insertText', false, t)).catch(() => {});
      return;
    }
    document.execCommand(cmd);
  };

  const standardMenus = (appId: string): MenuCategory[] => {
    const focused = wm.getFocusedWindow();
    return [
      {
        label: 'File',
        items: [
          { label: 'New Window', shortcut: '⌥N', disabled: registry.get(appId)?.singleton, action: () => ctx.launch(appId) },
          { label: 'Close Window', shortcut: '⌥W', disabled: !focused, action: () => focused && void wm.closeWindow(focused.state.id) },
        ],
      },
      {
        label: 'Edit',
        items: [
          { label: 'Undo', shortcut: '⌘Z', action: editCommand('undo') },
          { label: 'Redo', shortcut: '⇧⌘Z', action: editCommand('redo') },
          { separator: true, label: '' },
          { label: 'Cut', shortcut: '⌘X', action: editCommand('cut') },
          { label: 'Copy', shortcut: '⌘C', action: editCommand('copy') },
          { label: 'Paste', shortcut: '⌘V', action: editCommand('paste') },
          { label: 'Select All', shortcut: '⌘A', action: editCommand('selectAll') },
        ],
      },
      {
        label: 'View',
        items: [
          { label: 'Enter Full Screen', action: () => void document.documentElement.requestFullscreen?.().catch(() => {}) },
          { label: 'Show All Windows', shortcut: 'F3', action: () => wm.toggleOverview() },
        ],
      },
      {
        label: 'Window',
        items: [
          { label: 'Minimize', shortcut: '⌥M', disabled: !focused, action: () => focused && void wm.minimizeWindow(focused.state.id) },
          { label: 'Zoom', disabled: !focused, action: () => focused && wm.zoom(focused.state.id) },
          { label: 'Bring All to Front', action: () => wm.activateApp(appId) },
          { separator: true, label: '' },
          ...wm.getAllWindows().map((w) => ({ label: w.state.title, checked: w === focused, action: () => wm.focusWindow(w.state.id) })),
        ],
      },
      {
        label: 'Help',
        items: [
          { label: 'Lifo Documentation', action: () => window.open('https://lifo.sh/docs', '_blank', 'noopener') },
          { label: 'Keyboard Shortcuts', action: () => ctx.launch('settings', 'keyboard') },
          { label: 'Welcome', action: () => ctx.open(`${HOME}/Desktop/Welcome.md`) },
        ],
      },
    ];
  };

  /** App menus first; File/Edit/View get the standard items after the app's own. */
  const mergeMenus = (app: MenuCategory[], std: MenuCategory[]): MenuCategory[] => {
    const out: MenuCategory[] = [];
    const appBy = new Map(app.map((c) => [c.label, c]));
    for (const s of std.filter((c) => ['File', 'Edit', 'View'].includes(c.label))) {
      const a = appBy.get(s.label);
      appBy.delete(s.label);
      if (!a) out.push(s);
      else {
        const extra = s.items.filter((i) => !a.items.some((x) => x.label === i.label));
        out.push({ label: s.label, items: extra.length ? [...a.items, { separator: true, label: '' }, ...extra] : a.items });
      }
    }
    out.push(...appBy.values());
    out.push(...std.filter((c) => c.label === 'Window' || c.label === 'Help'));
    return out;
  };

  const aboutApp = (name: string, icon: string) => {
    infoDialog(name, h('div', { class: 'lf-about-app' }, h('div', { class: 'lf-about-app-icon', html: icon }), h('p', {}, `${name} for Lifo Desktop`), h('p', { class: 'lf-muted' }, 'Runs in this tab, on the same Lifo box as every other app.')));
  };

  const downloadSnapshot = async () => {
    const bytes = await box.sandbox.exportSnapshot();
    const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
    download(`lifo-box-${stamp}.tar.gz`, bytes, 'application/gzip');
  };

  const restoreSnapshot = async () => {
    const file = await pickFile('.gz,.tgz,application/gzip');
    if (!file) return;
    const ok = await confirmDialog('Restore this snapshot?', `Files from “${file.name}” are written into the box, replacing files with the same paths.`, 'Restore');
    if (!ok) return;
    await box.sandbox.importSnapshot(new Uint8Array(await file.arrayBuffer()));
    bus.emit('trash:change', {});
  };

  const restart = async () => {
    const ok = await confirmDialog('Restart the box?', 'Running programs stop. Your files are kept.', 'Restart');
    if (ok) location.reload();
  };

  const menubar = new MenuBar(root, {
    bus,
    settings,
    model: menuModel,
    ports: () => box.ports(),
    openPort: (p) => ctx.launch('browser', String(p)),
    spotlight: () => spotlight.toggle(),
  });
  void menubar;

  new Dock(root, {
    bus,
    wm,
    registry,
    settings,
    ctx: () => ctx,
    pinned: PINNED,
    trashCount: () => files.trashCount(),
    moveToTrash: (paths) => files.moveToTrash(paths),
    emptyTrash: () => void files.emptyTrash(),
  });

  const spotlight = new Spotlight(root, registry, box, (id, arg) => ctx.launch(id, arg), (p) => ctx.open(p));
  const switcher = new AppSwitcher(root, wm, registry);
  root.append(overlay);

  installShortcuts({
    spotlight: () => spotlight.toggle(),
    switcher: (back) => switcher.next(back),
    switcherActive: () => switcher.active,
    overview: () => wm.toggleOverview(),
    exitOverlays: () => {
      if (wm.overviewActive) {
        wm.exitOverview();
        return true;
      }
      if (switcher.active) {
        switcher.cancel();
        return true;
      }
      return false;
    },
    newWindow: () => {
      const id = wm.getFocusedWindow()?.state.appId ?? 'finder';
      ctx.launch(id === 'about' ? 'finder' : id);
    },
    newTab: () => {
      const f = wm.getFocusedWindow();
      if (!f || !newTerminalTab(f.appInstance)) ctx.launch('terminal');
    },
    closeWindow: () => {
      const f = wm.getFocusedWindow();
      if (f) void wm.closeWindow(f.state.id);
    },
    minimize: () => {
      const f = wm.getFocusedWindow();
      if (f) void wm.minimizeWindow(f.state.id);
    },
    quitApp: () => {
      const f = wm.getFocusedWindow();
      if (f) void wm.quitApp(f.state.appId);
    },
    settings: () => ctx.launch('settings'),
  });

  // Exposed for debugging in development, and for tests that drive the desktop.
  (window as unknown as { __lifoDesktop?: unknown }).__lifoDesktop = { box, wm, registry, ctx, settings, wallpapers: WALLPAPERS.map((w) => w.id) };

  progress(100);
  await new Promise((r) => setTimeout(r, 250));
  splash.classList.add('fade-out');
  setTimeout(() => splash.remove(), 500);

  registry.launch('finder', ctx, HOME);
}

boot().catch((e) => {
  console.error(e);
  const root = document.getElementById('desktop-root');
  if (root) root.innerHTML = `<div class="lf-boot-error">Lifo Desktop could not start: ${String((e as Error)?.message ?? e)}</div>`;
});
