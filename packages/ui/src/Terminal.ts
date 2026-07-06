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

  constructor(container: HTMLElement) {
    this.xterm = new XTerminal({
      theme: THEME,
      fontFamily: '"Cascadia Code", "Fira Code", "JetBrains Mono", Menlo, monospace',
      fontSize: 14,
      lineHeight: 1.2,
      cursorBlink: true,
      cursorStyle: 'block',
      allowProposedApi: true,
    });

    this.fitAddon = new FitAddon();
    this.xterm.loadAddon(this.fitAddon);

    this.xterm.open(container);

    // Try WebGL, fall back to canvas
    try {
      const webgl = new WebglAddon();
      webgl.onContextLoss(() => webgl.dispose());
      this.xterm.loadAddon(webgl);
    } catch {
      // Canvas renderer is fine
    }

    this.fitAddon.fit();

    const resizeObserver = new ResizeObserver(() => {
      this.fitAddon.fit();
    });
    resizeObserver.observe(container);
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
