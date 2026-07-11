import { createContext, useContext } from 'react';

/**
 * Carries the active example's pre-highlighted code snippet down to the
 * terminal area, which renders it as a "README.md" tab. Provided by app-shell
 * so examples don't have to thread it through.
 */
export interface OutputChrome {
  /** Pre-highlighted HTML for the example's code sample (undefined = none). */
  snippet?: string;
}

const OutputChromeContext = createContext<OutputChrome | null>(null);

export const OutputChromeProvider = OutputChromeContext.Provider;

export function useOutputChrome(): OutputChrome | null {
  return useContext(OutputChromeContext);
}
