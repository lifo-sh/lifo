import { useMemo } from 'react';
import { Kernel } from '@lifo-sh/core';
import type { Terminal } from '@lifo-sh/ui';
import { ExamplePanel } from '@/components/example-panel';
import { TerminalTabs, type TabSpec } from '@/components/terminal-tabs';
import { bootShell } from '@/lib/shell';
import { seedHttp } from '@/examples/http-seed';

const TAB_NAMES = ['Server', 'Client', 'Client2', 'Server 5173', 'New Tab'];

export default function HttpExample() {
  const kernelPromise = useMemo(async () => {
    const kernel = new Kernel();
    await kernel.boot({ persist: false });
    const g = globalThis as unknown as { __setLifoKernel?: (fn: () => Kernel) => void };
    if (typeof g.__setLifoKernel === 'function') g.__setLifoKernel(() => kernel);
    seedHttp(kernel);
    // Best-effort tunnel start (needs a host relay on :3005; harmless if absent).
    kernel.serviceManager?.start('tunnel').catch(() => {});
    return kernel;
  }, []);

  const bootTab = (term: Terminal) => {
    void kernelPromise.then((kernel) => bootShell(term, kernel, { network: true }));
  };

  const initial: TabSpec[] = TAB_NAMES.map((label) => ({ label, onReady: bootTab }));

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
      <TerminalTabs initial={initial} onAdd={(i) => ({ label: `Terminal ${i + 1}`, onReady: bootTab })} />
    </ExamplePanel>
  );
}
