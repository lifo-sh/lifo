import { useEffect, useRef, useState } from 'react';
import { Kernel } from '@lifo-sh/core';
import type { Terminal } from '@lifo-sh/ui';
import type { FirefoxFrame, FirefoxStatus } from 'lifo-pkg-agent/firefox';
import { ExamplePanel } from '@/components/example-panel';
import { TerminalArea } from '@/components/terminal-area';
import { ResizablePanelGroup, ResizablePanel, ResizableHandle } from '@/components/ui/resizable';
import { bootShell } from '@/lib/shell';
import { setFirefox } from '@/lib/agent';

// The in-browser agent from the browser-in-browser experiment (lifo-pkg-agent), split pane: a Lifo
// terminal on the left, a real Firefox (Gecko compiled to WebAssembly) on the right. `browser`
// drives that Firefox; `agent` (a WebLLM model on WebGPU) runs `browser` and shell commands until
// it can answer. Firefox needs a cross-origin isolated page and a network relay (on lifo.sh: a
// login); without them `browser` reads pages as text instead.
async function relayUrl(): Promise<string | null> {
  const res = await fetch('/api/wisp-token', { cache: 'no-store' }).catch(() => null);
  if (!res?.ok) return null;
  return ((await res.json()) as { url?: string }).url ?? null;
}

export default function AgentExample() {
  const kernelRef = useRef<Kernel | null>(null);
  const [kernel, setKernel] = useState<Kernel | null>(null);
  const paneRef = useRef<HTMLDivElement>(null);
  const ffRef = useRef<FirefoxFrame | null>(null);
  const [status, setStatus] = useState<{ state: FirefoxStatus | 'off'; text: string }>({ state: 'booting', text: 'starting…' });

  useEffect(() => {
    const pane = paneRef.current;
    if (!pane) return;
    let gone = false;
    setFirefox(() => ffRef.current);
    void import('lifo-pkg-agent/firefox').then(({ canRunFirefox, mountFirefox }) => {
      if (gone) return;
      if (!canRunFirefox()) {
        setStatus({ state: 'off', text: "this page isn't cross-origin isolated here (Chrome isolates it), so browser reads pages as text" });
        return;
      }
      ffRef.current = mountFirefox(pane, {
        wispUrl: relayUrl,
        noRelayMessage: 'no network relay: log in to lifo.sh (or run the playground with the website checkout next to it)',
        onStatus: (text, state) => !gone && setStatus({ text, state }),
      });
    });
    return () => {
      gone = true;
      setFirefox(null);
      ffRef.current = null;
      pane.replaceChildren();
    };
  }, []);

  const bootTab = async (term: Terminal) => {
    if (kernelRef.current) {
      void bootShell(term, kernelRef.current, { pkgs: ['git', 'agent'] });
      return;
    }
    const k = new Kernel();
    await k.boot({ persist: false });
    await bootShell(term, k, { pkgs: ['git', 'agent'] });
    kernelRef.current = k;
    setKernel(k);
  };

  const box = kernel ? { kernel, env: kernel.getDefaultEnv() } : null;
  const dot = status.state === 'ready' ? 'bg-tokyo-green' : status.state === 'booting' ? 'bg-tokyo-orange animate-pulse' : 'bg-tokyo-comment';

  return (
    <ExamplePanel
      title="Browser agent (WebLLM + Firefox)"
      subtitle={
        <>
          An AI agent and a real Firefox, both in this tab. Try <code>browser open news.ycombinator.com</code>, then{' '}
          <code>browser state | head</code> and <code>browser click new</code>, then{' '}
          <code>agent "What is the top story on Hacker News right now?"</code>. The model runs on WebGPU and downloads
          once (about 1.2 GB); Firefox is about 50 MB.
        </>
      }
      headerAction={
        <span className="flex items-center gap-1.5 text-[11px] font-mono text-tokyo-comment max-w-[420px]">
          <span className={`h-2 w-2 shrink-0 rounded-full ${dot}`} />
          <span className="truncate">Firefox: {status.text}</span>
        </span>
      }
    >
      <ResizablePanelGroup direction="horizontal" autoSaveId="pg-agent-split" className="relative flex-1 min-h-0">
        <ResizablePanel defaultSize={42} minSize={20}>
          <TerminalArea box={box} bootTab={(t) => void bootTab(t)} />
        </ResizablePanel>
        <ResizableHandle className="mx-0.5" />
        <ResizablePanel defaultSize={58} minSize={20} className="relative overflow-hidden bg-[#1c1b22]">
          <div ref={paneRef} className="absolute inset-0" />
          {status.state !== 'ready' && (
            <div className="absolute inset-0 grid place-items-center p-6 text-center text-[12px] text-tokyo-comment pointer-events-none">
              <p className="max-w-sm">Firefox: {status.text}</p>
            </div>
          )}
        </ResizablePanel>
      </ResizablePanelGroup>
    </ExamplePanel>
  );
}
