import { useCallback, useEffect, useRef, useState } from 'react';
import type { Sandbox } from '@lifo-sh/core';
import { RotateCw, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { listProcesses, killProcess, type ProcInfo } from '@/lib/process-inspector';

interface ProcessPanelProps {
  /** The example's sandbox, or null until it has booted. */
  sandbox: Sandbox | null;
  /** Poll only while the panel is actually visible (the active tab). */
  active: boolean;
  /** Reports the current process count (for a tab badge). */
  onCount?: (n: number) => void;
}

function fmtUptime(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

const STATUS_COLOR: Record<ProcInfo['status'], string> = {
  running: 'text-tokyo-green',
  sleeping: 'text-tokyo-blue',
  stopped: 'text-tokyo-yellow',
  zombie: 'text-tokyo-red',
};

/**
 * Inline process manager: a live table of the VM's processes (driven by
 * `ps --json` on a dedicated inspector shell) with a kill button per row.
 * Rendered as a terminal tab, so it never overlaps the preview iframe.
 */
export function ProcessPanel({ sandbox, active, onCount }: ProcessPanelProps) {
  const [procs, setProcs] = useState<ProcInfo[]>([]);
  const busy = useRef(false);

  const refresh = useCallback(async () => {
    if (!sandbox || busy.current) return;
    busy.current = true;
    try {
      const rows = await listProcesses(sandbox);
      const visible = rows.filter((p) => !(p.command === 'ps' && p.args.includes('--json')));
      setProcs(visible);
      onCount?.(visible.length);
    } finally {
      busy.current = false;
    }
  }, [sandbox, onCount]);

  useEffect(() => {
    if (!sandbox) return;
    void refresh();
    // Fast poll while visible, slow heartbeat when hidden (keeps the tab badge live).
    const timer = setInterval(() => void refresh(), active ? 1500 : 6000);
    return () => clearInterval(timer);
  }, [sandbox, active, refresh]);

  const onKill = async (pid: number) => {
    if (!sandbox) return;
    await killProcess(sandbox, pid);
    void refresh();
  };

  return (
    <div className="flex flex-col h-full w-full min-h-0 bg-tokyo-bg">
      <div className="flex items-center justify-between px-3 py-1.5 border-b border-tokyo-border shrink-0">
        <span className="text-[12px] text-tokyo-comment">
          {procs.length} process{procs.length === 1 ? '' : 'es'}
        </span>
        <button
          onClick={() => void refresh()}
          title="Refresh"
          className="w-6 h-6 grid place-items-center rounded bg-transparent border-none text-tokyo-comment hover:text-tokyo-fg-bright cursor-pointer"
        >
          <RotateCw size={13} />
        </button>
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto">
        {procs.length === 0 ? (
          <div className="px-3 py-6 text-center text-[11px] text-tokyo-comment">No running processes.</div>
        ) : (
          <table className="w-full table-fixed text-[11px] font-code">
            <thead className="sticky top-0 bg-tokyo-bg-dark text-tokyo-comment">
              <tr className="text-left">
                <th className="font-normal px-3 py-1.5 w-12">PID</th>
                <th className="font-normal py-1.5">Command</th>
                <th className="font-normal py-1.5 w-16">State</th>
                <th className="font-normal py-1.5 w-14">Uptime</th>
                <th className="py-1.5 w-8" />
              </tr>
            </thead>
            <tbody>
              {procs.map((p) => {
                // args often already includes argv0 (the command name), so don't
                // render it twice ("node node app.mjs").
                const label = p.args[0] === p.command ? p.args.join(' ') : [p.command, ...p.args].join(' ');
                return (
                  <tr key={p.pid} className="border-t border-tokyo-border/50 hover:bg-tokyo-hover">
                    <td className="px-3 py-1.5 text-tokyo-comment tabular-nums align-top">{p.pid}</td>
                    <td className="py-1.5 text-tokyo-fg-bright align-top">
                      <span className="break-all">{label}</span>
                      {p.foreground && (
                        <span className="ml-1.5 text-[9px] uppercase tracking-wide text-tokyo-blue">fg</span>
                      )}
                    </td>
                    <td className={cn('py-1.5 align-top', STATUS_COLOR[p.status])}>{p.status}</td>
                    <td className="py-1.5 text-tokyo-muted tabular-nums align-top">{fmtUptime(p.uptimeMs)}</td>
                    <td className="py-1.5 pr-2 align-top">
                      {p.command !== 'shell' && (
                        <button
                          onClick={() => void onKill(p.pid)}
                          title={`Kill ${p.pid}`}
                          className="w-5 h-5 grid place-items-center rounded bg-transparent border-none text-tokyo-comment hover:text-tokyo-red cursor-pointer"
                        >
                          <X size={13} />
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
