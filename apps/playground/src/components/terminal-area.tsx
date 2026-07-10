import { useEffect, useRef, useState } from 'react';
import type { Terminal } from '@lifo-sh/ui';
import { MoreVertical, Plus, Activity, Square, RotateCcw, Download, Upload } from 'lucide-react';
import { cn } from '@/lib/utils';
import { TerminalView } from '@/components/terminal-view';
import { ProcessPanel } from '@/components/process-panel';
import { listProcesses, killProcess, type InspectableBox } from '@/lib/process-inspector';

interface TerminalAreaProps {
  /** Boot a shell for a terminal tab on the shared kernel/sandbox. `ordinal` is
   *  the terminal's position (0 = first) — project examples create the sandbox
   *  on ordinal 0 and attach extra shells for the rest. */
  bootTab: (term: Terminal, ordinal: number) => void;
  /** The box backing the Processes tab + Stop all; null until it's ready. */
  box: InspectableBox | null;
  /** Labels for the initial terminal tabs (default: one "Terminal 1"). */
  initialLabels?: string[];
  /** Show the "+" to open more terminals (default true). */
  canAdd?: boolean;
  /** Box-menu actions — only shown when provided (project examples). */
  onRestart?: () => void;
  onSnapshot?: () => void;
  onRestore?: () => void;
}

type Tab =
  | { id: number; kind: 'terminal'; label: string; ordinal: number }
  | { id: number; kind: 'process'; label: string };

/**
 * Shared terminal chrome (VS Code-like): flat tabbed terminals over one kernel,
 * a persistent "Processes" tab (the process manager), and a box menu (stop,
 * restart, snapshot, restore — the latter three only when handlers are given).
 */
export function TerminalArea({ bootTab, box, initialLabels, canAdd = true, onRestart, onSnapshot, onRestore }: TerminalAreaProps) {
  const labels = initialLabels?.length ? initialLabels : ['Terminal 1'];
  const [tabs, setTabs] = useState<Tab[]>(() => [
    ...labels.map((label, i) => ({ id: i, kind: 'terminal' as const, label, ordinal: i })),
    { id: labels.length, kind: 'process' as const, label: 'Processes' },
  ]);
  const [active, setActive] = useState(0);
  const [menuOpen, setMenuOpen] = useState(false);
  const [procCount, setProcCount] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const termsRef = useRef<Map<number, Terminal>>(new Map());
  const nextId = useRef(labels.length + 1);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const onDoc = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [menuOpen]);

  const focusTab = (i: number) => {
    setActive(i);
    const tab = tabs[i];
    if (tab?.kind === 'terminal') {
      const term = termsRef.current.get(tab.id);
      term?.refit();
      term?.focus();
    }
  };

  const addTerminal = () => {
    if (!box) return;
    const id = nextId.current++;
    const ordinal = tabs.filter((t) => t.kind === 'terminal').length;
    const procIdx = tabs.findIndex((x) => x.kind === 'process');
    setTabs((t) => {
      const next = [...t];
      const at = next.findIndex((x) => x.kind === 'process');
      next.splice(at, 0, { id, kind: 'terminal', label: `Terminal ${ordinal + 1}`, ordinal });
      return next;
    });
    setActive(procIdx); // the new terminal takes the slot Processes used to be at
  };

  const openProcesses = () => {
    setMenuOpen(false);
    const i = tabs.findIndex((t) => t.kind === 'process');
    if (i >= 0) focusTab(i);
  };

  const stopAll = async () => {
    if (!box) return;
    setMenuOpen(false);
    setBusy('Stopping…');
    try {
      const procs = await listProcesses(box);
      for (const p of procs) {
        if (p.command === 'shell' || (p.command === 'ps' && p.args.includes('--json'))) continue;
        await killProcess(box, p.pid);
      }
    } finally {
      setBusy(null);
    }
  };

  const run = (label: string, fn: () => void | Promise<void>) => async () => {
    setMenuOpen(false);
    setBusy(label);
    try {
      await fn();
    } finally {
      setBusy(null);
    }
  };

  const menuItems = [
    { label: 'Process manager', icon: Activity, onClick: openProcesses },
    { label: 'Stop all', icon: Square, onClick: () => void stopAll() },
    ...(onRestart ? [{ label: 'Restart box', icon: RotateCcw, onClick: () => { setMenuOpen(false); onRestart(); } }] : []),
    ...(onSnapshot ? [{ label: 'Snapshot (download)', icon: Download, onClick: run('Snapshotting…', onSnapshot) }] : []),
    ...(onRestore ? [{ label: 'Restore (upload)', icon: Upload, onClick: () => { setMenuOpen(false); onRestore(); } }] : []),
  ];

  return (
    <div className="flex flex-col h-full w-full min-h-0">
      {/* Tab strip — flat, flush, VS Code-like. */}
      <div className="flex items-stretch bg-tokyo-bg-dark border-b border-tokyo-border min-h-[30px] shrink-0">
        <div className="flex items-stretch flex-1 overflow-x-auto">
          {tabs.map((t, i) => (
            <button
              key={t.id}
              onClick={() => focusTab(i)}
              className={cn(
                'px-3 flex items-center gap-1.5 border-none border-r border-tokyo-border/60 text-xs cursor-pointer whitespace-nowrap transition-colors',
                i === active
                  ? 'bg-tokyo-bg text-tokyo-fg-bright shadow-[inset_0_2px_0_var(--color-tokyo-blue)]'
                  : 'bg-transparent text-tokyo-comment hover:bg-tokyo-hover hover:text-tokyo-muted',
              )}
            >
              {t.kind === 'process' && <Activity size={12} />}
              {t.label}
              {t.kind === 'process' && procCount > 0 && (
                <span className="text-[10px] tabular-nums opacity-70">({procCount})</span>
              )}
            </button>
          ))}
          {canAdd && (
            <button
              onClick={addTerminal}
              disabled={!box}
              title="New terminal"
              className="px-2 grid place-items-center bg-transparent border-none text-tokyo-comment hover:text-tokyo-fg-bright hover:bg-tokyo-hover cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <Plus size={14} />
            </button>
          )}
        </div>
        {busy && <span className="text-[10px] text-tokyo-comment px-2 self-center">{busy}</span>}
        <div className="relative flex items-stretch" ref={menuRef}>
          <button
            onClick={() => setMenuOpen((v) => !v)}
            disabled={!box}
            title="Box menu"
            className="px-2 grid place-items-center bg-transparent border-none text-tokyo-comment hover:text-tokyo-fg-bright hover:bg-tokyo-hover cursor-pointer disabled:opacity-40"
          >
            <MoreVertical size={15} />
          </button>
          {menuOpen && (
            <div className="absolute right-0 top-full z-30 w-52 py-1 bg-tokyo-bg-dark border border-tokyo-border shadow-2xl">
              {menuItems.map((it) => (
                <button
                  key={it.label}
                  onClick={it.onClick}
                  className="w-full flex items-center gap-2.5 px-3 py-1.5 text-[12px] text-left text-tokyo-fg bg-transparent border-none cursor-pointer hover:bg-tokyo-hover hover:text-tokyo-fg-bright"
                >
                  <it.icon size={13} className="text-tokyo-comment" />
                  {it.label}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="flex-1 relative overflow-hidden bg-tokyo-bg">
        {tabs.map((t, i) => (
          <div
            key={t.id}
            className="absolute inset-0 flex flex-col min-h-0"
            style={{ display: i === active ? 'flex' : 'none' }}
          >
            {t.kind === 'terminal' ? (
              <div className="flex-1 min-h-0 p-1.5">
                <TerminalView
                  className="w-full h-full"
                  onReady={(term) => {
                    termsRef.current.set(t.id, term);
                    bootTab(term, t.ordinal);
                  }}
                />
              </div>
            ) : (
              <div className="flex-1 min-h-0 flex flex-col">
                <ProcessPanel box={box} active={i === active} onCount={setProcCount} />
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
