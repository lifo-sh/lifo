import { WTerm } from '@wterm/dom';
import '@wterm/dom/css';
import type { ITerminal } from '@lifo-sh/core';

// Tokyo Night theme, mapped to wterm's CSS custom properties.
const THEME_VARS: Record<string, string> = {
  '--term-bg': '#1a1b26',
  '--term-fg': '#a9b1d6',
  '--term-cursor': '#c0caf5',
  '--term-color-0': '#15161e', // black
  '--term-color-1': '#f7768e', // red
  '--term-color-2': '#9ece6a', // green
  '--term-color-3': '#e0af68', // yellow
  '--term-color-4': '#7aa2f7', // blue
  '--term-color-5': '#bb9af7', // magenta
  '--term-color-6': '#7dcfff', // cyan
  '--term-color-7': '#a9b1d6', // white
  '--term-color-8': '#414868', // bright black
  '--term-color-9': '#f7768e', // bright red
  '--term-color-10': '#9ece6a', // bright green
  '--term-color-11': '#e0af68', // bright yellow
  '--term-color-12': '#7aa2f7', // bright blue
  '--term-color-13': '#bb9af7', // bright magenta
  '--term-color-14': '#7dcfff', // bright cyan
  '--term-color-15': '#c0caf5', // bright white
  '--term-font-family': '"Cascadia Code", "Fira Code", "JetBrains Mono", Menlo, monospace',
  '--term-font-size': '14px',
  '--term-line-height': '1.2',
};

/**
 * ITerminal implementation backed by @wterm/dom (Vercel Labs) — a Zig+WASM
 * terminal that renders to the DOM (native text selection, copy/paste, a11y).
 *
 * wterm's WASM core is inlined (base64) so no extra asset bundling is needed,
 * but init() is async. The ITerminal contract is synchronous, so we buffer
 * writes/focus until the core is ready.
 */
export class Terminal implements ITerminal {
  private wterm: WTerm;
  private ready = false;
  private pendingWrites: string[] = [];
  private wantFocus = false;
  private dataCallback: ((data: string) => void) | null = null;

  constructor(container: HTMLElement) {
    // Theme via CSS custom properties (inline styles win over wterm's .wterm class).
    for (const [key, value] of Object.entries(THEME_VARS)) {
      container.style.setProperty(key, value);
    }
    // wterm's base .wterm style adds padding/shadow/radius; neutralise so the
    // terminal fills its (already-framed) container, matching the old xterm look.
    container.style.padding = '0';
    container.style.boxShadow = 'none';
    container.style.borderRadius = '0';

    this.wterm = new WTerm(container, {
      cursorBlink: true,
      autoResize: true,
      onData: (data) => this.dataCallback?.(data),
    });

    this.wterm.init().then(() => {
      this.ready = true;
      for (const chunk of this.pendingWrites) this.wterm.write(chunk);
      this.pendingWrites = [];
      if (this.wantFocus) this.wterm.focus();
    }).catch((err) => {
      console.error('[lifo-ui] wterm failed to initialize:', err);
    });
  }

  write(data: string): void {
    if (this.ready) this.wterm.write(data);
    else this.pendingWrites.push(data);
  }

  writeln(data: string): void {
    this.write(data + '\r\n');
  }

  onData(callback: (data: string) => void): void {
    this.dataCallback = callback;
  }

  get cols(): number {
    return this.wterm.cols;
  }

  get rows(): number {
    return this.wterm.rows;
  }

  focus(): void {
    if (this.ready) this.wterm.focus();
    else this.wantFocus = true;
  }

  clear(): void {
    // wterm has no clear() method; the VT sequence clears screen + scrollback + homes.
    this.write('\x1b[2J\x1b[3J\x1b[H');
  }
}
