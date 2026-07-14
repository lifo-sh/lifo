import { useEffect, useRef } from 'react';
import { Terminal } from '@lifo-sh/ui';
import { useTheme, xtermTheme } from '@/lib/theme';

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
  const { mode } = useTheme();

  useEffect(() => {
    if (booted.current || !containerRef.current) return;
    booted.current = true;
    // On phones: shrink the font so enough columns fit, and use the DOM renderer
    // (WebGL's canvas desyncs vertically from the viewport on high-DPR touch).
    const isMobile = window.innerWidth < 640;
    const term = new Terminal(containerRef.current, {
      fontSize: isMobile ? 11 : 14,
      webgl: !isMobile,
      theme: xtermTheme(mode),
    });
    termRef.current = term;
    // Focus the terminal once its shell is wired up so you can type immediately.
    // Desktop only — auto-focusing on a phone would pop the on-screen keyboard.
    void Promise.resolve(onReady?.(term)).then(() => {
      if (!isMobile) term.focus();
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Follow the app's light/dark toggle.
  useEffect(() => {
    termRef.current?.setTheme(xtermTheme(mode));
  }, [mode]);

  // Re-adapt font size + renderer (and refit) when the viewport crosses the
  // phone breakpoint, since the terminal instance is preserved across it.
  useEffect(() => {
    const mq = window.matchMedia('(min-width: 640px)');
    const apply = () => {
      const term = termRef.current;
      if (!term) return;
      term.setFontSize(mq.matches ? 14 : 11);
      term.setWebgl(mq.matches);
    };
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, []);

  return <div ref={containerRef} className={className} />;
}
