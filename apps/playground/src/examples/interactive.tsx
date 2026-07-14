import { useMemo, useRef, useState } from 'react';
import { Kernel } from '@lifo-sh/core';
import type { Terminal } from '@lifo-sh/ui';
import { ShellExample } from '@/components/shell-example';
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

  // Show the welcome banner on the first terminal only, not every new tab.
  const firstBoot = useRef(true);
  const bootTab = (term: Terminal) => {
    const banner = firstBoot.current;
    firstBoot.current = false;
    void kernelPromise.then((k) => bootShell(term, k, { network: true, banner }));
  };

  const box = kernel ? { kernel, env: kernel.getDefaultEnv() } : null;

  return (
    <ShellExample
      title="Interactive Shell"
      subtitle="Full interactive terminal with persistence. Clone a repo, run a dev server, then open Browser to preview it."
      box={box}
      bootTab={bootTab}
    />
  );
}
