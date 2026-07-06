import { useMemo } from 'react';
import { Kernel } from '@lifo-sh/core';
import type { Terminal } from '@lifo-sh/ui';
import { ExamplePanel } from '@/components/example-panel';
import { TerminalTabs, type TabSpec } from '@/components/terminal-tabs';
import { bootShell } from '@/lib/shell';

export default function MultiExample() {
  // One kernel shared across all tabs (files persist across tabs).
  const kernelPromise = useMemo(() => {
    const kernel = new Kernel();
    return kernel.boot({ persist: false }).then(() => kernel);
  }, []);

  const bootTab = (term: Terminal) => {
    void kernelPromise.then((kernel) => bootShell(term, kernel, { pkgs: ['git'] }));
  };

  const initial: TabSpec[] = [
    { label: 'Terminal 1', onReady: bootTab },
    { label: 'Terminal 2', onReady: bootTab },
  ];

  return (
    <ExamplePanel
      title="Multi Terminal"
      subtitle="Multiple shells sharing one Sandbox — files are shared across tabs"
    >
      <TerminalTabs initial={initial} onAdd={(i) => ({ label: `Terminal ${i + 1}`, onReady: bootTab })} />
    </ExamplePanel>
  );
}
