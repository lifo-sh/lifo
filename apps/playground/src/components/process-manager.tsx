import { useCallback, useEffect, useRef, useState } from 'react';
import type { Sandbox } from '@lifo-sh/core';
import { Activity, X, RotateCw } from 'lucide-react';
import { cn } from '@/lib/utils';
import { listProcesses, killProcess, type ProcInfo } from '@/lib/process-inspector';

interface ProcessManagerProps {
  /** The example's sandbox, or null until it has booted. */
  sandbox: Sandbox | null;
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
 * Per-example process manager: a floating button (bottom-right of the panel)
 * that opens a live table of the VM's processes, driven by `ps --json` on a
 * dedicated inspector shell, with a kill button per row. Polls while open only.
 */
export function ProcessManager({ sandbox }: ProcessManagerProps) {
  const [open, setOpen] = useState(false);
  const [procs, setProcs] = useState<ProcInfo[]>([]);
  const [count, setCount] = useState(0);
  const busy = useRef(false);

  const refresh = useCallback(async () => {
    if (!sandbox || busy.current) return;
    busy.current = true;
    try {
      const rows = await listProcesses(sandbox);
      // Hide the inspector's own transient `ps` process from the list.
      const visible = rows.filter((p) => !(p.command === 'ps' && p.args.includes('--json')));
      setProcs(visible);
      setCount(visible.length);
    } finally {
      busy.current = false;
    }
  }, [sandbox]);

  // Keep the badge count fresh at a slow cadence even when closed; poll faster
  // while the panel is open.
  useEffect(() => {
    if (!sandbox) return;
    void refresh();
    const timer = setInterval(() => void refresh(), open ? 1500 : 5000);
    return () => clearInterval(timer);
  }, [sandbox, open, refresh]);

  const onKill = async (pid: number) => {
    if (!sandbox) return;
    await killProcess(sandbox, pid);
    void refresh();
  };

  if (!sandbox) return null;

  return (
    <>
      <button
        onClick={() => setOpen((v) => !v)}
        title="Process manager"
        className="absolute bottom-3 right-3 z-20 flex items-center gap-1.5 px-2.5 h-8 rounded-full bg-tokyo-bg-dark border border-tokyo-border text-tokyo-muted hover:text-tokyo-fg-bright shadow-lg cursor-pointer"
      >
        <Activity size={14} />
        <span className="text-[11px] font-code tabular-nums">{count}</span>
      </button>

      {open && (
        <div className="absolute bottom-14 right-3 z-20 w-[420px] max-w-[calc(100%-1.5rem)] max-h-[60%] flex flex-col rounded-lg bg-tokyo-bg-dark border border-tokyo-border shadow-2xl overflow-hidden">
          <div className="flex items-center justify-between px-3 py-2 border-b border-tokyo-border shrink-0">
            <span className="text-[12px] font-medium text-tokyo-fg-bright flex items-center gap-1.5">
              <Activity size={13} /> Processes
              <span className="text-tokyo-comment font-normal">({count})</span>
            </span>
            <div className="flex items-center gap-1">
              <button
                onClick={() => void refresh()}
                title="Refresh"
                className="w-6 h-6 grid place-items-center rounded bg-transparent border-none text-tokyo-comment hover:text-tokyo-fg-bright cursor-pointer"
              >
                <RotateCw size={13} />
              </button>
              <button
                onClick={() => setOpen(false)}
                title="Close"
                className="w-6 h-6 grid place-items-center rounded bg-transparent border-none text-tokyo-comment hover:text-tokyo-fg-bright cursor-pointer"
              >
                <X size={14} />
              </button>
            </div>
          </div>

          <div className="flex-1 min-h-0 overflow-y-auto">
            {procs.length === 0 ? (
              <div className="px-3 py-6 text-center text-[11px] text-tokyo-comment">
                No running processes.
              </div>
            ) : (
              <table className="w-full text-[11px] font-code">
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
                    // args often already includes argv0 (the command), so don't
                    // prepend it twice ("node node app.mjs").
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
                          <button
                            onClick={() => void onKill(p.pid)}
                            title={`Kill ${p.pid}`}
                            className="w-5 h-5 grid place-items-center rounded bg-transparent border-none text-tokyo-comment hover:text-tokyo-red cursor-pointer"
                          >
                            <X size={13} />
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
        </div>
      )}
    </>
  );
}
