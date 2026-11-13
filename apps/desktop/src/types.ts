import type { DesktopBox } from './core/box';
import type { EventBus } from './core/EventBus';
import type { WindowManager } from './core/WindowManager';
import type { AppRegistry } from './core/AppRegistry';
import type { Settings } from './core/settings';
import type { DesktopWindow } from './core/Window';
import type { FileOps } from './core/files';

// ─── App Context ───

/** Everything an app can reach: the box (shared by every app), the desktop's systems. */
export interface AppContext {
  box: DesktopBox;
  eventBus: EventBus;
  windowManager: WindowManager;
  appRegistry: AppRegistry;
  settings: Settings;
  files: FileOps;
  /** Open a path with the right app (folders in Finder, files by extension). */
  open(path: string): void;
  /** Launch an app (a new window), optionally with a path or URL. */
  launch(appId: string, arg?: string): void;
}

// ─── App Definition ───

export interface AppDefinition {
  id: string;
  name: string;
  /** Dock/launcher icon: an SVG string (see icons.ts). */
  icon: string;
  /** File extensions this app opens (e.g. ['.txt', '.md']). */
  extensions?: string[];
  /** Initial window size. */
  size?: { width: number; height: number };
  minSize?: { width: number; height: number };
  /**
   * 'standard': the window draws a title bar. 'unified': the app draws its own toolbar (marked
   * with data-drag) and the traffic lights float over its top-left corner, like Finder.
   */
  chrome?: 'standard' | 'unified';
  /** One window at most (System Settings, About): launching again focuses it. */
  singleton?: boolean;
  /** Don't show in the dock or Spotlight's app list. */
  hidden?: boolean;
  createInstance(ctx: AppContext, arg?: string): AppInstance;
}

// ─── App Instance ───

export interface AppInstance {
  readonly appId: string;
  mount(container: HTMLElement, win: DesktopWindow): void;
  unmount(): void;
  focus?(): void;
  getTitle(): string;
  /** App-specific menus, merged into the standard File/Edit/View/Window/Help. */
  getMenus?(): MenuCategory[];
  /** Return false (or a promise of false) to keep the window open, e.g. unsaved changes. */
  canClose?(): boolean | Promise<boolean>;
  /** Called after the window was resized (terminals refit). */
  onResize?(): void;
}

// ─── Menu ───

export interface MenuCategory {
  label: string;
  items: MenuItem[];
}

export interface MenuItem {
  label: string;
  shortcut?: string;
  action?: () => void;
  separator?: boolean;
  disabled?: boolean;
  checked?: boolean;
}

// ─── Window State ───

export interface WindowState {
  id: string;
  appId: string;
  title: string;
  x: number;
  y: number;
  width: number;
  height: number;
  minimized: boolean;
  maximized: boolean;
  zIndex: number;
}
