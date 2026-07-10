import { useMemo, useState } from 'react';
import { Kernel } from '@lifo-sh/core';
import type { Terminal } from '@lifo-sh/ui';
import { ExamplePanel } from '@/components/example-panel';
import { TerminalArea } from '@/components/terminal-area';
import { bootShell } from '@/lib/shell';

export default function MultiExample() {
  const [kernel, setKernel] = useState<Kernel | null>(null);
  // One kernel shared across all tabs (files persist across tabs).
  const kernelPromise = useMemo(() => {
    const k = new Kernel();
    return k.boot({ persist: false }).then(() => {
      setKernel(k);
      return k;
    });
  }, []);

  const bootTab = (term: Terminal) => {
    void kernelPromise.then((k) => bootShell(term, k, { pkgs: ['git'] }));
  };

  const box = kernel ? { kernel, env: kernel.getDefaultEnv() } : null;

  return (
    <ExamplePanel
      title="Multi Terminal"
      subtitle="Multiple shells sharing one Sandbox — files are shared across tabs"
    >
      <TerminalArea box={box} bootTab={bootTab} initialLabels={['Terminal 1', 'Terminal 2']} />
    </ExamplePanel>
  );
}
