import { useEffect, useRef, useState } from 'react';
import type { Sandbox } from '@lifo-sh/core';
import type { Terminal } from '@lifo-sh/ui';
import { MoreVertical, Plus, Activity, Square, RotateCcw, Download, Upload } from 'lucide-react';
import { cn } from '@/lib/utils';
import { TerminalView } from '@/components/terminal-view';
import { ProcessPanel } from '@/components/process-panel';
import { listProcesses, killProcess } from '@/lib/process-inspector';
import { downloadSnapshot, pickAndRestoreSnapshot } from '@/lib/box-snapshot';

interface ProjectTerminalsProps {
  sandbox: Sandbox | null;
  /** Boots the first terminal — this creates the Sandbox (see project-example). */
  onFirstTerminal: (term: Terminal) => void;
  /** Boots an extra terminal onto the already-created shared kernel. */
  onNewTerminal: (term: Terminal) => void;
  /** Reboot the box: recreate the sandbox from its initial files. */
  onRestart: () => void;
}

type Tab = { id: number; kind: 'terminal'; label: string } | { id: number; kind: 'process'; label: string };

/**
 * The terminal area for project examples: tabbed terminals (each a shell on the
 * shared kernel) plus a persistent "Processes" tab, and a box menu (stop,
 * restart, snapshot, restore). Replaces the single terminal + floating process
 * manager, so nothing overlays the preview iframe.
 */
export function ProjectTerminals({ sandbox, onFirstTerminal, onNewTerminal, onRestart }: ProjectTerminalsProps) {
  const [tabs, setTabs] = useState<Tab[]>([
    { id: 0, kind: 'terminal', label: 'Terminal 1' },
    { id: 1, kind: 'process', label: 'Processes' },
  ]);
  const [active, setActive] = useState(0);
  const [menuOpen, setMenuOpen] = useState(false);
  const [procCount, setProcCount] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const termsRef = useRef<Map<number, Terminal>>(new Map());
  const nextId = useRef(2);
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
    if (!sandbox) return;
    const id = nextId.current++;
    const termNo = tabs.filter((t) => t.kind === 'terminal').length + 1;
    // Insert before the always-last Processes tab.
    setTabs((t) => {
      const procIdx = t.findIndex((x) => x.kind === 'process');
      const next = [...t];
      next.splice(procIdx, 0, { id, kind: 'terminal', label: `Terminal ${termNo}` });
      return next;
    });
    setActive(tabs.findIndex((x) => x.kind === 'process')); // new terminal lands where Processes was
  };

  const openProcesses = () => {
    setMenuOpen(false);
    const i = tabs.findIndex((t) => t.kind === 'process');
    if (i >= 0) focusTab(i);
  };

  const stopAll = async () => {
    if (!sandbox) return;
    setMenuOpen(false);
    setBusy('Stopping…');
    try {
      const procs = await listProcesses(sandbox);
      for (const p of procs) {
        if (p.command === 'shell' || (p.command === 'ps' && p.args.includes('--json'))) continue;
        await killProcess(sandbox, p.pid);
      }
    } finally {
      setBusy(null);
    }
  };

  const snapshot = async () => {
    if (!sandbox) return;
    setMenuOpen(false);
    setBusy('Snapshotting…');
    try {
      await downloadSnapshot(sandbox);
    } finally {
      setBusy(null);
    }
  };

  const restore = () => {
    if (!sandbox) return;
    setMenuOpen(false);
    pickAndRestoreSnapshot(sandbox, () => {
      // Disk is restored in place; tell the user to re-run their dev command.
      const t = tabs[active];
      if (t?.kind === 'terminal') termsRef.current.get(t.id)?.write('\r\n\x1b[33m[box restored from snapshot — re-run your commands]\x1b[0m\r\n');
    });
  };

  const restart = () => {
    setMenuOpen(false);
    onRestart();
  };

  const menuItems = [
    { label: 'Process manager', icon: Activity, onClick: openProcesses },
    { label: 'Stop all', icon: Square, onClick: () => void stopAll() },
    { label: 'Restart box', icon: RotateCcw, onClick: restart },
    { label: 'Snapshot (download)', icon: Download, onClick: () => void snapshot() },
    { label: 'Restore (upload)', icon: Upload, onClick: restore },
  ];

  return (
    <div className="flex flex-col h-full w-full min-h-0">
      <div className="flex items-center gap-0.5 bg-tokyo-bg-dark border border-tokyo-border border-b-0 rounded-t-lg px-1 min-h-[34px] shrink-0">
        <div className="flex items-center gap-0.5 flex-1 overflow-x-auto">
          {tabs.map((t, i) => (
            <button
              key={t.id}
              onClick={() => focusTab(i)}
              className={cn(
                'px-3.5 py-[5px] border-none text-xs font-medium cursor-pointer rounded-t-[5px] transition-colors whitespace-nowrap flex items-center gap-1.5',
                i === active
                  ? 'text-tokyo-blue bg-tokyo-bg shadow-[inset_0_-2px_0_var(--color-tokyo-blue)]'
                  : 'text-tokyo-comment bg-transparent hover:text-tokyo-muted hover:bg-tokyo-hover',
              )}
            >
              {t.kind === 'process' && <Activity size={12} />}
              {t.label}
              {t.kind === 'process' && procCount > 0 && (
                <span className="text-[10px] tabular-nums text-tokyo-comment">({procCount})</span>
              )}
            </button>
          ))}
          <button
            onClick={addTerminal}
            disabled={!sandbox}
            title="New terminal"
            className="px-2 py-[3px] bg-transparent border border-tokyo-border text-tokyo-comment text-sm rounded-[4px] ml-0.5 leading-none hover:text-tokyo-muted hover:bg-tokyo-hover hover:border-tokyo-comment disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <Plus size={13} />
          </button>
        </div>
        {busy && <span className="text-[10px] text-tokyo-comment px-1.5">{busy}</span>}
        <div className="relative" ref={menuRef}>
          <button
            onClick={() => setMenuOpen((v) => !v)}
            disabled={!sandbox}
            title="Box menu"
            className="w-7 h-7 grid place-items-center rounded bg-transparent border-none text-tokyo-comment hover:text-tokyo-fg-bright hover:bg-tokyo-hover cursor-pointer disabled:opacity-40"
          >
            <MoreVertical size={15} />
          </button>
          {menuOpen && (
            <div className="absolute right-0 top-8 z-30 w-52 py-1 rounded-md bg-tokyo-bg-dark border border-tokyo-border shadow-2xl">
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

      <div className="flex-1 relative border border-tokyo-border border-t-0 rounded-b-lg overflow-hidden">
        {tabs.map((t, i) => (
          <div
            key={t.id}
            className="absolute inset-0 flex flex-col min-h-0"
            style={{ display: i === active ? 'flex' : 'none' }}
          >
            {t.kind === 'terminal' ? (
              <div className="flex-1 min-h-0 p-2">
                <TerminalView
                  className="w-full h-full"
                  onReady={(term) => {
                    termsRef.current.set(t.id, term);
                    // The very first terminal (id 0) creates the sandbox.
                    if (t.id === 0) onFirstTerminal(term);
                    else onNewTerminal(term);
                  }}
                />
              </div>
            ) : (
              <div className="flex-1 min-h-0 flex flex-col">
                <ProcessPanel sandbox={sandbox} active={i === active} onCount={setProcCount} />
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
