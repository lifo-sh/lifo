import '@xterm/xterm/css/xterm.css';
import './styles/theme.css';
import './styles/desktop.css';
import './styles/window.css';
import './styles/menubar.css';
import './styles/dock.css';
import './styles/spotlight.css';
import './styles/animations.css';

import { Kernel } from '@lifo-sh/core';
import { EventBus } from './core/EventBus';
import { AppRegistry } from './core/AppRegistry';
import { Desktop } from './core/Desktop';
import { WindowManager } from './core/WindowManager';
import { MenuBar } from './core/MenuBar';
import { Dock } from './core/Dock';
import { Spotlight } from './core/Spotlight';
import { registerBuiltinApps, finderDefinition, terminalDefinition, textEditDefinition } from './apps/index';
import type { AppContext } from './types';

async function boot() {
  const root = document.getElementById('desktop-root')!;

  // ── Splash screen ──
  const splash = document.createElement('div');
  splash.className = 'lf-splash';
  splash.innerHTML = `
    <div class="lf-splash-logo">\uD83D\uDDA5\uFE0F</div>
    <div class="lf-splash-bar"><div class="lf-splash-bar-fill"></div></div>
  `;
  root.appendChild(splash);
  const progressBar = splash.querySelector('.lf-splash-bar-fill') as HTMLElement;

  // ── Boot kernel ──
  progressBar.style.width = '20%';
  const kernel = new Kernel();
  await kernel.boot({ persist: true });
  progressBar.style.width = '50%';

  // Ensure Desktop dir exists
  try {
    await kernel.vfs.mkdir('/home/user/Desktop', { recursive: true });
  } catch { /* exists */ }

  // ── Create core systems ──
  const eventBus = new EventBus();
  const appRegistry = new AppRegistry();

  registerBuiltinApps(appRegistry);
  progressBar.style.width = '70%';

  // ── Desktop surface ──
  const desktop = new Desktop(root, kernel.vfs, appRegistry, (path) => {
    appRegistry.openFile(path, appCtx, windowManager);
  });

  // ── Window Manager ──
  const windowManager = new WindowManager(eventBus, desktop.windowLayer);

  // ── App Context (shared) ──
  const appCtx: AppContext = {
    kernel,
    eventBus,
    windowManager,
    appRegistry,
  };

  // ── Menu Bar ──
  new MenuBar(root, eventBus, windowManager);
  progressBar.style.width = '85%';

  // ── Dock ──
  const dock = new Dock(root, eventBus, windowManager, appRegistry, (appId) => {
    appRegistry.launch(appId, appCtx, windowManager);
  });

  dock.addPinnedApp(finderDefinition);
  dock.addPinnedApp(terminalDefinition);
  dock.addSeparator();
  dock.addPinnedApp(textEditDefinition);

  // ── Spotlight ──
  const spotlight = new Spotlight(
    root,
    appRegistry,
    kernel.vfs,
    (appId) => appRegistry.launch(appId, appCtx, windowManager),
    (path) => appRegistry.openFile(path, appCtx, windowManager),
  );

  progressBar.style.width = '100%';

  // ── Hide splash ──
  await new Promise((r) => setTimeout(r, 400));
  splash.classList.add('fade-out');
  await new Promise((r) => setTimeout(r, 600));
  splash.remove();

  // ── Auto-launch Finder ──
  appRegistry.launch('finder', appCtx, windowManager);

  // ── Keyboard shortcuts ──
  document.addEventListener('keydown', (e) => {
    const meta = e.metaKey || e.ctrlKey;
    if (!meta) return;

    const focused = windowManager.getFocusedWindow();

    switch (e.key.toLowerCase()) {
      case ' ': // Cmd+Space → Spotlight
        e.preventDefault();
        spotlight.toggle();
        break;
      case 'w': // Close window
        e.preventDefault();
        if (focused) windowManager.closeWindow(focused.state.id);
        break;
      case 'h': // Hide/minimize (same as Cmd+M)
        e.preventDefault();
        if (focused) windowManager.minimizeWindow(focused.state.id);
        break;
      case 'm': // Minimize
        e.preventDefault();
        if (focused) windowManager.minimizeWindow(focused.state.id);
        break;
      case 'n': // New window of focused app
        e.preventDefault();
        if (focused) {
          appRegistry.launch(focused.state.appId, appCtx, windowManager);
        }
        break;
      case ',': // Preferences placeholder
        e.preventDefault();
        break;
      case 'q': // Quit app — close all windows for that app
        e.preventDefault();
        if (focused) {
          const appWindows = windowManager.getWindowsByApp(focused.state.appId);
          for (const w of appWindows) windowManager.closeWindow(w.state.id);
        }
        break;
      case 'tab': // App switcher — cycle through windows
        if (meta) {
          e.preventDefault();
          const allWindows = windowManager.getAllWindows();
          if (allWindows.length > 1 && focused) {
            const idx = allWindows.findIndex((w) => w.state.id === focused.state.id);
            const next = allWindows[(idx + 1) % allWindows.length];
            windowManager.focusWindow(next.state.id);
          }
        }
        break;
    }
  });
}

boot().catch(console.error);
