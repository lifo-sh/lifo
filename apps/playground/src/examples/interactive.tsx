import { useMemo, useState } from 'react';
import { Kernel } from '@lifo-sh/core';
import type { Terminal } from '@lifo-sh/ui';
import { ExamplePanel } from '@/components/example-panel';
import { TerminalArea } from '@/components/terminal-area';
import { bootShell } from '@/lib/shell';
import { seedInteractive } from '@/examples/interactive-seed';

export default function InteractiveExample() {
  const [kernel, setKernel] = useState<Kernel | null>(null);
  // Persistent kernel, seeded once; exposed to the Vite dev-server port bridge.
  const kernelPromise = useMemo(async () => {
    const k = new Kernel();
    await k.boot({ persist: true });
    const g = globalThis as unknown as { __setLifoKernel?: (fn: () => Kernel) => void };
    if (typeof g.__setLifoKernel === 'function') g.__setLifoKernel(() => k);
    seedInteractive(k);
    await k.bootServices();
    setKernel(k);
    return k;
  }, []);

  const bootTab = (term: Terminal) => {
    void kernelPromise.then((k) => bootShell(term, k, { network: true }));
  };

  const box = kernel ? { kernel, env: kernel.getDefaultEnv() } : null;

  return (
    <ExamplePanel title="Interactive Shell" subtitle="Full interactive terminal with persistence">
      <TerminalArea box={box} bootTab={bootTab} />
    </ExamplePanel>
  );
}
