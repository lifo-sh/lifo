import { useMemo } from 'react';
import { Kernel } from '@lifo-sh/core';
import type { Terminal } from '@lifo-sh/ui';
import { ExamplePanel } from '@/components/example-panel';
import { TerminalTabs, type TabSpec } from '@/components/terminal-tabs';
import { bootShell } from '@/lib/shell';
import { seedInteractive } from '@/examples/interactive-seed';

export default function InteractiveExample() {
  // Persistent kernel, seeded once; exposed to the Vite dev-server port bridge.
  const kernelPromise = useMemo(async () => {
    const kernel = new Kernel();
    await kernel.boot({ persist: true });
    const g = globalThis as unknown as { __setLifoKernel?: (fn: () => Kernel) => void };
    if (typeof g.__setLifoKernel === 'function') g.__setLifoKernel(() => kernel);
    seedInteractive(kernel);
    await kernel.bootServices();
    return kernel;
  }, []);

  const bootTab = (term: Terminal) => {
    void kernelPromise.then((kernel) => bootShell(term, kernel, { network: true }));
  };

  const initial: TabSpec[] = [{ label: 'Terminal 1', onReady: bootTab }];

  return (
    <ExamplePanel title="Interactive Shell" subtitle="Full interactive terminal with persistence">
      <TerminalTabs initial={initial} onAdd={(i) => ({ label: `Terminal ${i + 1}`, onReady: bootTab })} />
    </ExamplePanel>
  );
}
