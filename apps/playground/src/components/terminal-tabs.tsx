import { useRef, useState } from 'react';
import type { Terminal } from '@lifo-sh/ui';
import { TerminalView } from '@/components/terminal-view';
import { cn } from '@/lib/utils';

export interface TabSpec {
  label: string;
  onReady: (term: Terminal) => void | Promise<void>;
}

interface TerminalTabsProps {
  /** Initial tabs, created up front (they share the parent's kernel). */
  initial: TabSpec[];
  /** When provided, shows a "+" button; called with the new tab's index. */
  onAdd?: (index: number) => TabSpec;
}

/**
 * Unifies the interactive/multi/http tab systems. Each tab hosts one
 * TerminalView (kept mounted; visibility toggled) whose `onReady` wires a shell
 * onto the shared kernel. Inactive tabs stay in the DOM — the terminal's own
 * ResizeObserver refits when a tab becomes visible again.
 */
export function TerminalTabs({ initial, onAdd }: TerminalTabsProps) {
  const [tabs, setTabs] = useState<TabSpec[]>(initial);
  const [active, setActive] = useState(0);
  const termsRef = useRef<Array<Terminal | null>>([]);

  function focusTab(i: number) {
    setActive(i);
    const term = termsRef.current[i];
    term?.refit();
    term?.focus();
  }

  function addTab() {
    if (!onAdd) return;
    const spec = onAdd(tabs.length);
    setTabs((t) => [...t, spec]);
    setActive(tabs.length);
  }

  return (
    <div className="flex flex-col flex-1 min-h-0">
      <div className="flex items-center gap-0.5 bg-tokyo-bg-dark border border-tokyo-border border-b-0 rounded-t-lg px-1 min-h-[34px] shrink-0 overflow-x-auto">
        {tabs.map((t, i) => (
          <button
            key={i}
            onClick={() => focusTab(i)}
            className={cn(
              'px-3.5 py-[5px] border-none text-xs font-medium cursor-pointer rounded-t-[5px] transition-colors whitespace-nowrap',
              i === active
                ? 'text-tokyo-blue bg-tokyo-bg shadow-[inset_0_-2px_0_var(--color-tokyo-blue)]'
                : 'text-tokyo-comment bg-transparent hover:text-tokyo-muted hover:bg-tokyo-hover',
            )}
          >
            {t.label}
          </button>
        ))}
        {onAdd ? (
          <button
            onClick={addTab}
            title="New terminal"
            className="px-2.5 py-[3px] bg-transparent border border-tokyo-border text-tokyo-comment text-sm rounded-[4px] ml-0.5 leading-none hover:text-tokyo-muted hover:bg-tokyo-hover hover:border-tokyo-comment"
          >
            +
          </button>
        ) : null}
      </div>
      <div className="flex-1 relative border border-tokyo-border border-t-0 rounded-b-lg overflow-hidden">
        {tabs.map((t, i) => (
          <div key={i} className="absolute inset-0 p-2" style={{ visibility: i === active ? 'visible' : 'hidden' }}>
            <TerminalView
              className="w-full h-full"
              onReady={(term) => {
                termsRef.current[i] = term;
                void t.onReady(term);
              }}
            />
          </div>
        ))}
      </div>
    </div>
  );
}
