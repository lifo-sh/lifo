import { Terminal as XTerminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import type { ITerminal } from '@lifo-sh/core';

// Tokyo Night theme
const THEME = {
  background: '#1a1b26',
  foreground: '#a9b1d6',
  cursor: '#c0caf5',
  cursorAccent: '#1a1b26',
  selectionBackground: '#33467c',
  black: '#15161e',
  red: '#f7768e',
  green: '#9ece6a',
  yellow: '#e0af68',
  blue: '#7aa2f7',
  magenta: '#bb9af7',
  cyan: '#7dcfff',
  white: '#a9b1d6',
  brightBlack: '#414868',
  brightRed: '#f7768e',
  brightGreen: '#9ece6a',
  brightYellow: '#e0af68',
  brightBlue: '#7aa2f7',
  brightMagenta: '#bb9af7',
  brightCyan: '#7dcfff',
  brightWhite: '#c0caf5',
};

export class Terminal implements ITerminal {
  private xterm: XTerminal;
  private fitAddon: FitAddon;
  private container: HTMLElement;
  private fitRaf = 0;
  private webglAddon: WebglAddon | null = null;

  constructor(container: HTMLElement, options?: { fontSize?: number; webgl?: boolean }) {
    this.container = container;
    this.xterm = new XTerminal({
      theme: THEME,
      fontFamily: '"Cascadia Code", "Fira Code", "JetBrains Mono", Menlo, monospace',
      fontSize: options?.fontSize ?? 14,
      lineHeight: 1.2,
      cursorBlink: true,
      cursorStyle: 'block',
      allowProposedApi: true,
      // Treat macOS Option as Meta so Option+←/→, Option+b/f/d, and
      // Option+Backspace emit escape sequences (word-jump/word-delete) rather
      // than inserting accented characters.
      macOptionIsMeta: true,
    });

    this.fitAddon = new FitAddon();
    this.xterm.loadAddon(this.fitAddon);

    this.xterm.open(container);

    this.setWebgl(options?.webgl !== false);
    this.scheduleFit();

    const resizeObserver = new ResizeObserver(() => {
      this.scheduleFit();
    });
    resizeObserver.observe(container);
  }

  /**
   * Toggle the WebGL renderer. WebGL gives the best throughput on desktop, but
   * its canvas backing store desyncs from the DOM scroll layer on high-DPR touch
   * devices (the viewport ends up vertically offset from the rendered text), so
   * callers disable it on mobile — the DOM renderer is used there. Safe to call
   * live when the viewport crosses the mobile/desktop breakpoint.
   */
  setWebgl(enabled: boolean): void {
    if (enabled && !this.webglAddon) {
      try {
        const webgl = new WebglAddon();
        webgl.onContextLoss(() => {
          webgl.dispose();
          if (this.webglAddon === webgl) this.webglAddon = null;
        });
        this.xterm.loadAddon(webgl);
        this.webglAddon = webgl;
      } catch {
        // DOM renderer is fine
      }
    } else if (!enabled && this.webglAddon) {
      this.webglAddon.dispose();
      this.webglAddon = null;
    }
    this.scheduleFit();
  }

  /** Change the font size and refit (e.g. when crossing the phone breakpoint). */
  setFontSize(px: number): void {
    if (this.xterm.options.fontSize === px) return;
    this.xterm.options.fontSize = px;
    this.scheduleFit();
  }

  /**
   * Fit on the next animation frame, coalescing bursts and skipping while the
   * container has no layout box (e.g. a hidden keep-alive panel). Fitting a
   * zero-size element yields 0 cols/rows and leaves the WebGL canvas mismatched
   * with the text grid — the cause of clipped/oversized rendering on reveal.
   */
  private scheduleFit(): void {
    if (this.fitRaf) cancelAnimationFrame(this.fitRaf);
    this.fitRaf = requestAnimationFrame(() => {
      this.fitRaf = 0;
      if (this.container.offsetWidth === 0 || this.container.offsetHeight === 0) return;
      try {
        this.fitAddon.fit();
      } catch {
        // Renderer not ready yet; the next resize/refit will retry.
      }
    });
  }

  /** Re-measure and fit — call when a hidden terminal becomes visible again. */
  refit(): void {
    this.scheduleFit();
  }

  write(data: string): void {
    this.xterm.write(data);
  }

  writeln(data: string): void {
    this.xterm.writeln(data);
  }

  onData(callback: (data: string) => void): void {
    this.xterm.onData(callback);
  }

  get cols(): number {
    return this.xterm.cols;
  }

  get rows(): number {
    return this.xterm.rows;
  }

  focus(): void {
    this.xterm.focus();
  }

  clear(): void {
    this.xterm.clear();
  }
}
