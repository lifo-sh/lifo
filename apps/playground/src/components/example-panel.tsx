import { type ReactNode, useState } from 'react';
import { Info, PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import { useOutputChrome, ReportProcessesProvider } from '@/components/output-chrome';
import { useTheme } from '@/lib/theme';

interface ExamplePanelProps {
  title: string;
  subtitle?: ReactNode;
  children: ReactNode;
}

/**
 * Compact output-panel chrome (VS Code-like): a full-width navbar, the example
 * body flush beneath it, and a thin status bar at the bottom. The description
 * is collapsed by default (info toggle).
 */
export function ExamplePanel({ title, subtitle, children }: ExamplePanelProps) {
  const chrome = useOutputChrome();
  const { mode } = useTheme();
  const [showDesc, setShowDesc] = useState(false);
  // Reported by the terminal area (null = this example has no box/terminal).
  const [procs, setProcs] = useState<number | null>(null);

  return (
    <div className="flex flex-col flex-1 min-h-0">
      {/* Navbar — end to end. */}
      <div className="flex items-center gap-1.5 h-9 px-2 border-b border-tokyo-border bg-tokyo-bg-dark shrink-0">
        {chrome?.canToggleCode && (
          <button
            onClick={chrome.toggleCode}
            title={chrome.codeOpen ? 'Hide code panel' : 'Show code panel'}
            className="w-6 h-6 grid place-items-center rounded bg-transparent border-none text-tokyo-comment hover:text-tokyo-fg-bright hover:bg-tokyo-hover cursor-pointer shrink-0"
          >
            {chrome.codeOpen ? <PanelLeftClose size={14} /> : <PanelLeftOpen size={14} />}
          </button>
        )}
        <span className="text-[13px] font-semibold text-tokyo-fg-bright truncate">{title}</span>
        {subtitle && (
          <button
            onClick={() => setShowDesc((v) => !v)}
            title="About this example"
            className={
              'w-6 h-6 grid place-items-center rounded bg-transparent border-none cursor-pointer shrink-0 ml-auto ' +
              (showDesc ? 'text-tokyo-blue' : 'text-tokyo-comment hover:text-tokyo-fg-bright hover:bg-tokyo-hover')
            }
          >
            <Info size={14} />
          </button>
        )}
      </div>
      {subtitle && showDesc && (
        <div className="text-[11px] text-tokyo-comment leading-relaxed px-3 py-2 border-b border-tokyo-border bg-tokyo-bg-dark shrink-0">
          {subtitle}
        </div>
      )}

      <ReportProcessesProvider value={setProcs}>
        <div className="flex-1 min-h-0 flex flex-col">{children}</div>
      </ReportProcessesProvider>

      {/* Status bar. */}
      <div className="flex items-center gap-3 h-6 px-3 border-t border-tokyo-border bg-tokyo-bg-dark text-[10.5px] text-tokyo-comment shrink-0 select-none">
        {procs !== null && (
          <span className="flex items-center gap-1.5">
            <span
              className={
                'inline-block w-1.5 h-1.5 rounded-full ' + (procs > 0 ? 'bg-tokyo-green' : 'bg-tokyo-comment/50')
              }
            />
            {procs > 0 ? `${procs} running` : 'idle'}
          </span>
        )}
        <span className="ml-auto flex items-center gap-1">
          <span className="w-1.5 h-1.5 rounded-full bg-tokyo-blue/70" />
          Lifo VM
        </span>
        <span className="uppercase tracking-wide">{mode}</span>
      </div>
    </div>
  );
}
