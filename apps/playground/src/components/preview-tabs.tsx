import { useState } from 'react';
import type { Kernel } from '@lifo-sh/core';
import { cn } from '@/lib/utils';
import { UiPreviewBrowser } from '@/components/ui-preview-browser';
import { NoSwPreview } from '@/components/nosw-preview';

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
  /**
   * Which transport mounts each pane. `postmessage` needs the kernel, since it
   * talks to the port registry directly instead of through a service worker.
   * Both engines get the SAME tabs — the SW-free path used to render only the
   * first one, so sibling services like tinbase's studio were unreachable.
   */
  engine?: 'sw' | 'postmessage';
  kernel?: Kernel | null;
}

/**
 * Tabbed preview pane. The tab strip matches the terminal tab strip exactly
 * (flat, 1px top accent on the active tab). No top border — the resizable
 * handle above is the only separator, so there's no double line.
 */
export function PreviewTabs({ boxId, tabs, engine = 'sw', kernel = null }: PreviewTabsProps) {
  const [active, setActive] = useState(0);

  return (
    <div className="flex flex-col h-full w-full min-h-0">
      <div className="flex items-stretch bg-tokyo-bg-dark border-b border-tokyo-border min-h-[36px] shrink-0 overflow-x-auto">
        {tabs.map((tab, i) => (
          <button
            key={`${tab.port}:${tab.path ?? '/'}`}
            onClick={() => setActive(i)}
            className={cn(
              'px-3.5 flex items-center border-none border-r border-tokyo-border/60 text-xs cursor-pointer whitespace-nowrap transition-colors',
              i === active
                ? 'text-tokyo-fg-bright bg-tokyo-bg shadow-[inset_0_1px_0_var(--color-tokyo-blue)]'
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
            {engine === 'postmessage' ? (
              kernel ? (
                <NoSwPreview kernel={kernel} port={tab.port} path={tab.path ?? '/'} />
              ) : (
                <div className="flex-1 h-full grid place-items-center text-[12px] text-tokyo-comment">Booting box…</div>
              )
            ) : (
              <UiPreviewBrowser boxId={boxId} port={tab.port} path={tab.path} />
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
