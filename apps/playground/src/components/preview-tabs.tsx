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
 * Tabbed preview pane (same tab chrome as the terminal tabs): each tab hosts
 * its own PreviewBrowser. All panes stay mounted — switching tabs only toggles
 * visibility, so each preview keeps its state (route, scroll, session).
 */
export function PreviewTabs({ boxId, tabs }: PreviewTabsProps) {
  const [active, setActive] = useState(0);

  // The tab bar is always present (Chrome-like), even with a single preview.
  return (
    <div className="flex flex-col h-full w-full min-h-0">
      <div className="flex items-center gap-0.5 bg-tokyo-bg-dark border border-tokyo-border border-b-0 rounded-t-lg px-1 min-h-[34px] shrink-0 overflow-x-auto">
        {tabs.map((tab, i) => (
          <button
            key={`${tab.port}:${tab.path ?? '/'}`}
            onClick={() => setActive(i)}
            className={cn(
              'px-3 py-[5px] bg-transparent border-none text-sm rounded-[4px] leading-none cursor-pointer',
              i === active
                ? 'text-tokyo-fg-bright bg-tokyo-hover'
                : 'text-tokyo-comment hover:text-tokyo-muted hover:bg-tokyo-hover',
            )}
          >
            {tab.label}
          </button>
        ))}
      </div>
      <div className="flex-1 relative border border-tokyo-border border-t-0 rounded-b-lg overflow-hidden">
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
