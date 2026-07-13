import { useState } from 'react';
import { Moon, Sun, PanelLeftClose, ChevronDown, ChevronRight } from 'lucide-react';
import { exampleGroups, sectionsFor } from '@/examples/registry';
import { cn } from '@/lib/utils';
import { useTheme } from '@/lib/theme';
import { LifoLogo } from '@/components/logo';

interface SidebarNavProps {
  activeId: string;
  onSelect: (id: string) => void;
  /** When provided, shows a collapse button in the header (desktop only). */
  onCollapse?: () => void;
}

export function SidebarNav({ activeId, onSelect, onCollapse }: SidebarNavProps) {
  const { mode, toggle } = useTheme();
  // Collapsed section keys — groups by name, subgroups as "group::subgroup".
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const isCollapsed = (key: string) => collapsed.has(key);
  const toggleSection = (key: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });

  const itemButton = (e: { id: string; label: string }, indented = false) => (
    <button
      key={e.id}
      onClick={() => onSelect(e.id)}
      className={cn(
        'block w-full py-2 border-none text-[13px] text-left cursor-pointer transition-colors',
        indented ? 'pl-9 pr-4' : 'px-4',
        e.id === activeId
          ? 'bg-tokyo-active text-tokyo-blue font-medium'
          : 'bg-transparent text-tokyo-muted hover:bg-tokyo-hover hover:text-tokyo-fg-bright',
      )}
    >
      {e.label}
    </button>
  );

  return (
    <nav className="h-full flex flex-col overflow-y-auto bg-tokyo-bg-dark">
      <div className="p-4 pb-3 border-b border-tokyo-border shrink-0">
        <div className="flex items-center gap-2">
          <LifoLogo className="size-[22px] shrink-0" />
          <h1 className="text-lg font-bold text-tokyo-fg-bright tracking-tight">Lifo</h1>
          <div className="ml-auto flex items-center gap-0.5">
            <button
              onClick={toggle}
              title={mode === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
              className="w-7 h-7 grid place-items-center rounded-md bg-transparent border-none text-tokyo-comment hover:text-tokyo-fg-bright hover:bg-tokyo-hover cursor-pointer"
            >
              {mode === 'dark' ? <Sun size={15} /> : <Moon size={15} />}
            </button>
            {onCollapse && (
              <button
                onClick={onCollapse}
                title="Collapse sidebar"
                className="w-7 h-7 grid place-items-center rounded-md bg-transparent border-none text-tokyo-comment hover:text-tokyo-fg-bright hover:bg-tokyo-hover cursor-pointer"
              >
                <PanelLeftClose size={15} />
              </button>
            )}
          </div>
        </div>
        <p className="text-[11px] text-tokyo-comment mt-1">Sandbox Examples</p>
      </div>

      {exampleGroups.map((group) => {
        const groupOpen = !isCollapsed(group);
        const sections = sectionsFor(group);
        return (
          <div key={group} className="py-2 border-b border-tokyo-border last:border-b-0">
            <button
              onClick={() => toggleSection(group)}
              className="flex items-center gap-1 w-full px-3 py-1 border-none bg-transparent cursor-pointer text-[10px] font-semibold uppercase tracking-widest text-tokyo-comment hover:text-tokyo-fg-bright"
            >
              {groupOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
              <span>{group}</span>
            </button>

            {groupOpen && sections.map(({ subgroup, items }) => {
              if (subgroup === '') return <div key="_none">{items.map((e) => itemButton(e))}</div>;
              const key = `${group}::${subgroup}`;
              const subOpen = !isCollapsed(key);
              return (
                <div key={key} className="mt-0.5">
                  <button
                    onClick={() => toggleSection(key)}
                    className="flex items-center gap-1 w-full pl-5 pr-3 py-1 border-none bg-transparent cursor-pointer text-[11px] font-medium text-tokyo-comment hover:text-tokyo-fg-bright"
                  >
                    {subOpen ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
                    <span>{subgroup}</span>
                  </button>
                  {subOpen && items.map((e) => itemButton(e, true))}
                </div>
              );
            })}
          </div>
        );
      })}
    </nav>
  );
}
