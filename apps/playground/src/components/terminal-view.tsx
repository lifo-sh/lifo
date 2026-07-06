import { useEffect, useRef } from 'react';
import { Terminal } from '@lifo-sh/ui';

interface TerminalViewProps {
  className?: string;
  /** Called once with the created Terminal — wire up the shell/kernel here. */
  onReady?: (term: Terminal) => void | Promise<void>;
}

/**
 * Imperative wrapper around @lifo-sh/ui's xterm Terminal. Creates the terminal
 * once (guarded), hands it to `onReady`. There's no dispose on the underlying
 * Terminal and the app keeps panels mounted, so no teardown is needed; the
 * Terminal's own ResizeObserver refits when the container (or a resizable
 * panel) changes size.
 */
export function TerminalView({ className, onReady }: TerminalViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const booted = useRef(false);
  const termRef = useRef<Terminal | null>(null);

  useEffect(() => {
    if (booted.current || !containerRef.current) return;
    booted.current = true;
    // On phones: shrink the font so enough columns fit, and use the DOM renderer
    // (WebGL's canvas desyncs vertically from the viewport on high-DPR touch).
    const isMobile = window.innerWidth < 640;
    const term = new Terminal(containerRef.current, {
      fontSize: isMobile ? 11 : 14,
      webgl: !isMobile,
    });
    termRef.current = term;
    void onReady?.(term);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return <div ref={containerRef} className={className} />;
}
