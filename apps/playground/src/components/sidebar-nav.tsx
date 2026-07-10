import { Moon, Sun } from 'lucide-react';
import { examples, exampleGroups } from '@/examples/registry';
import { cn } from '@/lib/utils';
import { useTheme } from '@/lib/theme';

interface SidebarNavProps {
  activeId: string;
  onSelect: (id: string) => void;
}

export function SidebarNav({ activeId, onSelect }: SidebarNavProps) {
  const { mode, toggle } = useTheme();
  return (
    <nav className="h-full flex flex-col overflow-y-auto bg-tokyo-bg-darker">
      <div className="p-4 pb-3 border-b border-tokyo-border shrink-0">
        <div className="flex items-center gap-2">
          <img
            src={`${import.meta.env.BASE_URL}logo.png`}
            alt="Lifo"
            width={22}
            height={22}
            className="rounded-[5px] shrink-0"
          />
          <h1 className="text-lg font-bold text-tokyo-fg-bright tracking-tight">Lifo</h1>
          <button
            onClick={toggle}
            title={mode === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
            className="ml-auto w-7 h-7 grid place-items-center rounded-md bg-transparent border-none text-tokyo-comment hover:text-tokyo-fg-bright hover:bg-tokyo-hover cursor-pointer"
          >
            {mode === 'dark' ? <Sun size={15} /> : <Moon size={15} />}
          </button>
        </div>
        <p className="text-[11px] text-tokyo-comment mt-1">Sandbox Examples</p>
      </div>
      {exampleGroups.map((group) => (
        <div key={group} className="py-3 border-b border-tokyo-border last:border-b-0">
          <div className="text-[10px] font-semibold uppercase tracking-widest text-tokyo-comment px-4 pb-1.5">
            {group}
          </div>
          {examples
            .filter((e) => e.group === group)
            .map((e) => (
              <button
                key={e.id}
                onClick={() => onSelect(e.id)}
                className={cn(
                  'block w-full px-4 py-2 border-none text-[13px] text-left cursor-pointer transition-colors',
                  e.id === activeId
                    ? 'bg-tokyo-active text-tokyo-blue font-medium'
                    : 'bg-transparent text-tokyo-muted hover:bg-tokyo-hover hover:text-tokyo-fg-bright',
                )}
              >
                {e.label}
              </button>
            ))}
        </div>
      ))}
    </nav>
  );
}
