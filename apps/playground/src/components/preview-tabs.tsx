import { useState } from 'react';
import { cn } from '@/lib/utils';
import { PreviewBrowser } from '@/components/preview-browser';

export interface PreviewTab {
  /** Tab label, e.g. "App" or "Studio". */
  label: string;
  /** In-VM virtual port the preview points at. */
  port: number;
  /** Initial path inside the app (default "/") — e.g. "/_/" for tinbase studio. */
  path?: string;
}

interface PreviewTabsProps {
  boxId: string;
  tabs: PreviewTab[];
}

/**
 * Tabbed preview pane (flat, VS Code-like — matches the terminal tab strip):
 * each tab hosts its own PreviewBrowser. All panes stay mounted — switching
 * tabs only toggles visibility, so each preview keeps its state.
 */
export function PreviewTabs({ boxId, tabs }: PreviewTabsProps) {
  const [active, setActive] = useState(0);

  return (
    <div className="flex flex-col h-full w-full min-h-0">
      <div className="flex items-stretch bg-tokyo-bg-dark border-y border-tokyo-border min-h-[30px] shrink-0 overflow-x-auto">
        {tabs.map((tab, i) => (
          <button
            key={`${tab.port}:${tab.path ?? '/'}`}
            onClick={() => setActive(i)}
            className={cn(
              'px-3 flex items-center border-none border-r border-tokyo-border/60 text-xs cursor-pointer whitespace-nowrap transition-colors',
              i === active
                ? 'text-tokyo-fg-bright bg-tokyo-bg shadow-[inset_0_2px_0_var(--color-tokyo-blue)]'
                : 'text-tokyo-comment bg-transparent hover:text-tokyo-muted hover:bg-tokyo-hover',
            )}
          >
            {tab.label}
          </button>
        ))}
      </div>
      <div className="flex-1 relative overflow-hidden">
        {tabs.map((tab, i) => (
          <div
            key={`${tab.port}:${tab.path ?? '/'}`}
            className="absolute inset-0"
            style={{ display: i === active ? 'block' : 'none' }}
          >
            <PreviewBrowser boxId={boxId} port={tab.port} initialPath={tab.path} />
          </div>
        ))}
      </div>
    </div>
  );
}
