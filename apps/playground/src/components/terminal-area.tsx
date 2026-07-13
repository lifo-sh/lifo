import { useEffect, useRef, useState } from 'react';
import type { Terminal } from '@lifo-sh/ui';
import { MoreVertical, Plus, Activity, Square, RotateCcw, Download, Upload, X, FileText, Scissors } from 'lucide-react';
import { downloadSnapshot, pickAndRestoreSnapshot } from '@/lib/box-snapshot';
import { cn } from '@/lib/utils';
import { TerminalView } from '@/components/terminal-view';
import { ProcessPanel } from '@/components/process-panel';
import { CodeColumn } from '@/components/code-column';
import { useOutputChrome } from '@/components/output-chrome';
import { listProcesses, killProcess, type InspectableBox } from '@/lib/process-inspector';

interface TerminalAreaProps {
  /** Boot a shell for a newly-opened terminal tab. The example decides whether
   *  this is the first terminal (create the box) or an extra one (attach to the
   *  shared kernel) from its own state — the "+" is disabled until the box
   *  exists, so the first boot always runs alone. */
  bootTab: (term: Terminal) => void;
  /** The box backing the Processes tab + Stop all; null until it's ready. */
  box: InspectableBox | null;
  /** Labels for the initial terminal tabs (default: one "Terminal 1"). */
  initialLabels?: string[];
  /** Show the "+" to open more terminals (default true). */
  canAdd?: boolean;
  /** Restart the box — only shown when provided (project examples). Snapshot &
   *  restore are always offered whenever a box exists. */
  onRestart?: () => void;
  /** Prune the Expo project's node_modules for a small snapshot — only shown
   *  when provided (Expo examples). Runs before the user snapshots. */
  onPrune?: () => Promise<void>;
}

type Tab =
  | { id: number; kind: 'terminal'; label: string }
  | { id: number; kind: 'process'; label: string }
  | { id: number; kind: 'readme'; label: string };

const README_ID = -1;

/**
 * Shared terminal chrome (VS Code-like): flat tabbed terminals over one kernel,
 * a persistent "Processes" tab (the process manager), and a box menu (stop,
 * restart, snapshot, restore — the latter three only when handlers are given).
 * Every tab is closable; the box menu reopens Processes if it was closed.
 */
export function TerminalArea({ bootTab, box, initialLabels, canAdd = true, onRestart, onPrune }: TerminalAreaProps) {
  const labels = initialLabels?.length ? initialLabels : ['Terminal 1'];
  // The example's code sample, captured at mount, shown as a README.md tab.
  const chrome = useOutputChrome();
  const snippetRef = useRef(chrome?.snippet);
  const hasReadme = !!snippetRef.current;

  const [tabs, setTabs] = useState<Tab[]>(() => [
    ...(hasReadme ? [{ id: README_ID, kind: 'readme' as const, label: 'README.md' }] : []),
    ...labels.map((label, i) => ({ id: i, kind: 'terminal' as const, label })),
    { id: labels.length, kind: 'process' as const, label: 'Processes' },
  ]);
  // Default to the first terminal (README is present but not selected).
  const [active, setActive] = useState(hasReadme ? 1 : 0);
  const [menuOpen, setMenuOpen] = useState(false);
  const [procCount, setProcCount] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const termsRef = useRef<Map<number, Terminal>>(new Map());
  const termCounter = useRef(labels.length);
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
    const label = `Terminal ${++termCounter.current}`;
    setTabs((t) => {
      const at = t.findIndex((x) => x.kind === 'process');
      const next = [...t];
      if (at >= 0) next.splice(at, 0, { id, kind: 'terminal', label });
      else next.push({ id, kind: 'terminal', label });
      setActive(at >= 0 ? at : next.length - 1);
      return next;
    });
  };

  const closeTab = (i: number, e?: React.MouseEvent) => {
    e?.stopPropagation();
    const closing = tabs[i];
    if (closing?.kind === 'readme') return; // README is a permanent first tab
    if (closing?.kind === 'terminal') termsRef.current.delete(closing.id);
    setTabs((t) => t.filter((_, idx) => idx !== i));
    setActive((a) => {
      const newLen = tabs.length - 1;
      if (i < a) return a - 1;
      if (i === a) return Math.max(0, Math.min(a, newLen - 1));
      return a;
    });
  };

  const openProcesses = () => {
    setMenuOpen(false);
    const i = tabs.findIndex((t) => t.kind === 'process');
    if (i >= 0) {
      focusTab(i);
    } else {
      const id = nextId.current++;
      setTabs((t) => [...t, { id, kind: 'process', label: 'Processes' }]);
      setActive(tabs.length);
    }
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

  // VS Code-style shortcuts, scoped to this area (fires only when focus is
  // inside — hidden keep-alive'd areas never receive the event).
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
    const k = e.key.toLowerCase();
    if (k === 't') {
      e.preventDefault();
      addTerminal();
    } else if (k === 'w') {
      e.preventDefault();
      if (tabs.length) closeTab(active);
    }
  };

  const menuItems = [
    { label: 'Process manager', icon: Activity, onClick: openProcesses },
    { label: 'Stop all', icon: Square, onClick: () => void stopAll() },
    ...(onRestart ? [{ label: 'Restart box', icon: RotateCcw, onClick: () => { setMenuOpen(false); onRestart(); } }] : []),
    // Prune node_modules (Expo examples) — shrinks the box before snapshotting.
    ...(onPrune ? [{ label: 'Prune node_modules', icon: Scissors, onClick: run('Pruning node_modules (~15s)…', onPrune) }] : []),
    // Snapshot & restore work off any box's VFS, so every example gets them.
    ...(box ? [
      { label: 'Snapshot (download)', icon: Download, onClick: run('Snapshotting…', () => downloadSnapshot(box.kernel.vfs)) },
      { label: 'Restore (upload)', icon: Upload, onClick: () => { setMenuOpen(false); pickAndRestoreSnapshot(box.kernel.vfs); } },
    ] : []),
  ];

  return (
    <div className="flex flex-col h-full w-full min-h-0" onKeyDown={onKeyDown}>
      {/* Tab strip — flat, VS Code-like. */}
      <div className="flex items-stretch bg-tokyo-bg-dark border-b border-tokyo-border min-h-[36px] shrink-0">
        <div className="flex items-stretch flex-1 overflow-x-auto">
          {tabs.map((t, i) => {
            const running = t.kind === 'process' && procCount > 0;
            return (
            <div
              key={t.id}
              onClick={() => focusTab(i)}
              onAuxClick={(e) => { if (e.button === 1) closeTab(i, e); }}
              className={cn(
                'group relative flex items-center gap-2 pl-3.5 pr-2 border-r border-tokyo-border/60 text-xs cursor-pointer whitespace-nowrap select-none transition-colors',
                i === active
                  ? 'bg-tokyo-bg text-tokyo-fg-bright shadow-[inset_0_1px_0_var(--color-tokyo-blue)]'
                  : 'bg-transparent text-tokyo-comment hover:bg-tokyo-hover hover:text-tokyo-muted',
              )}
            >
              {t.kind === 'process' && <Activity size={12} className={cn('shrink-0', running && 'text-tokyo-green')} />}
              {t.kind === 'readme' && <FileText size={12} className="shrink-0 text-tokyo-blue" />}
              <span className={cn(t.kind === 'readme' && 'pr-1.5')}>{t.label}</span>
              {running && (
                <span className="text-[10px] tabular-nums text-tokyo-green">({procCount})</span>
              )}
              {t.kind !== 'readme' && (
                <button
                  onClick={(e) => closeTab(i, e)}
                  title="Close tab"
                  className={cn(
                    'grid place-items-center w-4 h-4 rounded-sm hover:bg-tokyo-active hover:text-tokyo-fg-bright shrink-0 transition-opacity',
                    i === active ? 'opacity-70 hover:opacity-100' : 'opacity-0 group-hover:opacity-70',
                  )}
                >
                  <X size={12} />
                </button>
              )}
            </div>
            );
          })}
          {canAdd && (
            <button
              onClick={addTerminal}
              disabled={!box}
              title="New terminal"
              className="px-2.5 grid place-items-center bg-transparent border-none text-tokyo-comment hover:text-tokyo-fg-bright hover:bg-tokyo-hover cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <Plus size={15} />
            </button>
          )}
        </div>
        {busy && <span className="text-[10px] text-tokyo-comment px-2 self-center">{busy}</span>}
        <div className="relative flex items-stretch" ref={menuRef}>
          <button
            onClick={() => setMenuOpen((v) => !v)}
            disabled={!box}
            title="Box menu"
            className="px-2.5 grid place-items-center bg-transparent border-none text-tokyo-comment hover:text-tokyo-fg-bright hover:bg-tokyo-hover cursor-pointer disabled:opacity-40"
          >
            <MoreVertical size={16} />
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
        {tabs.length === 0 ? (
          <div className="absolute inset-0 grid place-items-center text-[12px] text-tokyo-comment">
            <button
              onClick={addTerminal}
              disabled={!box}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded border border-tokyo-border text-tokyo-muted hover:text-tokyo-fg-bright hover:bg-tokyo-hover disabled:opacity-40"
            >
              <Plus size={14} /> New terminal
            </button>
          </div>
        ) : (
          tabs.map((t, i) => (
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
                      bootTab(term);
                    }}
                  />
                </div>
              ) : t.kind === 'readme' ? (
                <div className="flex-1 min-h-0">
                  <CodeColumn snippet={snippetRef.current} />
                </div>
              ) : (
                <div className="flex-1 min-h-0 flex flex-col">
                  <ProcessPanel box={box} active={i === active} onCount={setProcCount} />
                </div>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
