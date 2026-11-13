import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';

export type ThemeMode = 'light' | 'dark';

/** xterm color themes: Horizon (dark, the lifo.sh palette) and Tokyo Night Day (light). */
const XTERM_DARK = {
  background: '#05060f',
  foreground: '#d6d7e3',
  cursor: '#ffffff',
  cursorAccent: '#05060f',
  selectionBackground: '#8b5cf655',
  black: '#1a1b2a',
  red: '#ff6a4a',
  green: '#34d399',
  yellow: '#ffc79a',
  blue: '#6f86ff',
  magenta: '#a78bfa',
  cyan: '#7dd3fc',
  white: '#c4c6d6',
  brightBlack: '#5b5d75',
  brightRed: '#ff9a7a',
  brightGreen: '#6ee7b7',
  brightYellow: '#ffdcbc',
  brightBlue: '#a9b8ff',
  brightMagenta: '#c4b5fd',
  brightCyan: '#bae6fd',
  brightWhite: '#ffffff',
};

const XTERM_LIGHT = {
  background: '#e1e2e7',
  foreground: '#3760bf',
  cursor: '#343b58',
  cursorAccent: '#e1e2e7',
  selectionBackground: '#b6bfe2',
  black: '#e9e9ed',
  red: '#f52a65',
  green: '#587539',
  yellow: '#8c6c3e',
  blue: '#2e7de9',
  magenta: '#9854f1',
  cyan: '#007197',
  white: '#6172b0',
  brightBlack: '#a1a6c5',
  brightRed: '#f52a65',
  brightGreen: '#587539',
  brightYellow: '#8c6c3e',
  brightBlue: '#2e7de9',
  brightMagenta: '#9854f1',
  brightCyan: '#007197',
  brightWhite: '#3760bf',
};

export const xtermTheme = (mode: ThemeMode) => (mode === 'light' ? XTERM_LIGHT : XTERM_DARK);

interface ThemeContextValue {
  mode: ThemeMode;
  toggle: () => void;
}

const ThemeContext = createContext<ThemeContextValue>({ mode: 'dark', toggle: () => {} });

export function useTheme(): ThemeContextValue {
  return useContext(ThemeContext);
}

const STORAGE_KEY = 'lifo-theme';

function readInitial(): ThemeMode {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === 'light' || saved === 'dark') return saved;
  } catch {
    /* localStorage unavailable */
  }
  return 'dark';
}

function apply(mode: ThemeMode) {
  const el = document.documentElement;
  el.classList.toggle('dark', mode === 'dark');
  el.classList.toggle('light', mode === 'light');
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [mode, setMode] = useState<ThemeMode>(readInitial);

  useEffect(() => {
    apply(mode);
    try {
      localStorage.setItem(STORAGE_KEY, mode);
    } catch {
      /* ignore */
    }
  }, [mode]);

  const toggle = () => setMode((m) => (m === 'light' ? 'dark' : 'light'));

  return <ThemeContext.Provider value={{ mode, toggle }}>{children}</ThemeContext.Provider>;
}
