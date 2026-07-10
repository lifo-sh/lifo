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
