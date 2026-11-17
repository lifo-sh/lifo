// Desktop keyboard shortcuts. A browser tab can't take ⌘W, ⌘Q, ⌘N, ⌘Tab or ⌘Space (the browser
// or the OS keeps them), so the desktop uses Option (⌥) for window and app commands, and also
// accepts ⌘ wherever the browser does pass it through (an installed web app, kiosk mode).
// Matching uses e.code, because ⌥ plus a letter types a symbol on macOS.

export const SHORTCUTS: [string, string][] = [
  ['⌥Space  or  ⌃Space', 'Spotlight'],
  ['⌥Tab', 'Switch apps (hold ⌥)'],
  ['F3  or  ⌥↑', 'Show all windows'],
  ['⌥N', 'New window'],
  ['⌥T', 'New Terminal tab'],
  ['⌥W', 'Close window'],
  ['⌥M', 'Minimize window'],
  ['⌥Q', 'Quit app'],
  ['⌥,', 'System Settings'],
  ['⌘S', 'Save (TextEdit)'],
];

export interface ShortcutActions {
  spotlight(): void;
  switcher(back: boolean): void;
  switcherActive(): boolean;
  overview(): void;
  exitOverlays(): boolean;
  newWindow(): void;
  newTab(): void;
  closeWindow(): void;
  minimize(): void;
  quitApp(): void;
  settings(): void;
}

export function installShortcuts(a: ShortcutActions): void {
  window.addEventListener(
    'keydown',
    (e) => {
      const opt = e.altKey && !e.ctrlKey;
      const cmd = e.metaKey && !e.ctrlKey && !e.altKey;
      const run = (fn: () => void) => {
        e.preventDefault();
        e.stopPropagation();
        fn();
      };
      if (e.code === 'Escape' && a.exitOverlays()) return run(() => {});
      if (e.code === 'F3' || (opt && e.code === 'ArrowUp')) return run(() => a.overview());
      if (e.code === 'Space' && (opt || cmd || (e.ctrlKey && !e.altKey && !e.metaKey))) return run(() => a.spotlight());
      if (e.code === 'Tab' && (opt || cmd || a.switcherActive())) return run(() => a.switcher(e.shiftKey));
      if (!(opt || cmd)) return;
      switch (e.code) {
        case 'KeyN':
          return run(() => a.newWindow());
        case 'KeyT':
          return run(() => a.newTab());
        case 'KeyW':
          return run(() => a.closeWindow());
        case 'KeyM':
          return run(() => a.minimize());
        case 'KeyQ':
          return run(() => a.quitApp());
        case 'Comma':
          return run(() => a.settings());
      }
    },
    true,
  );
}
