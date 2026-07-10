import { useRef, useState } from 'react';
import { Kernel } from '@lifo-sh/core';
import type { Terminal } from '@lifo-sh/ui';
import { ExamplePanel } from '@/components/example-panel';
import { TerminalArea } from '@/components/terminal-area';
import { bootShell } from '@/lib/shell';

export default function GitExample() {
  const kernelRef = useRef<Kernel | null>(null);
  const [kernel, setKernel] = useState<Kernel | null>(null);

  const bootTab = async (term: Terminal, ordinal: number) => {
    if (ordinal === 0) {
      const k = new Kernel();
      await k.boot({ persist: false });
      await bootShell(term, k, { pkgs: ['git', 'ffmpeg'] });
      kernelRef.current = k;
      setKernel(k);
    } else if (kernelRef.current) {
      void bootShell(term, kernelRef.current, { pkgs: ['git', 'ffmpeg'] });
    }
  };

  const box = kernel ? { kernel, env: kernel.getDefaultEnv() } : null;

  return (
    <ExamplePanel
      title="Git"
      subtitle={
        <>
          Git via <code>lifo-pkg-git</code> — powered by isomorphic-git. Try <code>git init</code>,{' '}
          <code>git add</code>, <code>git commit</code>, branching, and more.
        </>
      }
    >
      <TerminalArea box={box} bootTab={(t, o) => void bootTab(t, o)} />
    </ExamplePanel>
  );
}
