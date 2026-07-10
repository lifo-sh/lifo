import { createContext, useContext } from 'react';

/**
 * Lets the per-example header (ExamplePanel) drive app-shell chrome it doesn't
 * own — namely collapsing/expanding the Code column — without threading props
 * through every example. The provider lives in app-shell; ExamplePanel reads it.
 */
export interface OutputChrome {
  /** True when there's a Code column that can be toggled (desktop, code example). */
  canToggleCode: boolean;
  /** Whether the Code column is currently open. */
  codeOpen: boolean;
  /** Toggle the Code column. */
  toggleCode: () => void;
}

const OutputChromeContext = createContext<OutputChrome | null>(null);

export const OutputChromeProvider = OutputChromeContext.Provider;

export function useOutputChrome(): OutputChrome | null {
  return useContext(OutputChromeContext);
}

/**
 * Lets the terminal area report its box's user-process count up to the example's
 * status bar (rendered by ExamplePanel). `null` means "no box" (a non-terminal
 * example), which the bar renders as a bare status line. Each ExamplePanel
 * provides its own, so keep-alive'd inactive examples don't clobber each other.
 */
const ReportProcessesContext = createContext<((n: number | null) => void) | null>(null);

export const ReportProcessesProvider = ReportProcessesContext.Provider;

export function useReportProcesses(): ((n: number | null) => void) | null {
  return useContext(ReportProcessesContext);
}
