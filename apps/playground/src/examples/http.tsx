import { useMemo, useState } from 'react';
import { Kernel } from '@lifo-sh/core';
import type { Terminal } from '@lifo-sh/ui';
import { ExamplePanel } from '@/components/example-panel';
import { TerminalArea } from '@/components/terminal-area';
import { bootShell } from '@/lib/shell';
import { seedHttp } from '@/examples/http-seed';

const TAB_NAMES = ['Server', 'Client', 'Client2', 'Server 5173', 'New Tab'];

export default function HttpExample() {
  const [kernel, setKernel] = useState<Kernel | null>(null);
  const kernelPromise = useMemo(async () => {
    const k = new Kernel();
    await k.boot({ persist: false });
    const g = globalThis as unknown as { __setLifoKernel?: (fn: () => Kernel) => void };
    if (typeof g.__setLifoKernel === 'function') g.__setLifoKernel(() => k);
    seedHttp(k);
    // The tunnel service unit is seeded (users can `systemctl start tunnel` if
    // they run a relay), but not auto-started — no relay exists in the browser,
    // so it would only flood the terminal with reconnect errors.
    setKernel(k);
    return k;
  }, []);

  const bootTab = (term: Terminal) => {
    void kernelPromise.then((k) => bootShell(term, k, { network: true }));
  };

  const box = kernel ? { kernel, env: kernel.getDefaultEnv() } : null;

  return (
    <ExamplePanel
      title="HTTP Server"
      subtitle={
        <>
          Virtual HTTP servers on in-VM ports — run <code>node server.js</code>, then{' '}
          <code>curl localhost:3000</code> (or <code>ports</code>) from another tab.
        </>
      }
    >
      <TerminalArea box={box} bootTab={bootTab} initialLabels={TAB_NAMES} />
    </ExamplePanel>
  );
}
