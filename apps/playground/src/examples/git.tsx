import { useRef, useState } from 'react';
import { Kernel } from '@lifo-sh/core';
import type { Terminal } from '@lifo-sh/ui';
import { ShellExample } from '@/components/shell-example';
import { bootShell } from '@/lib/shell';

export default function GitExample() {
  const kernelRef = useRef<Kernel | null>(null);
  const [kernel, setKernel] = useState<Kernel | null>(null);

  const bootTab = async (term: Terminal) => {
    if (kernelRef.current) {
      void bootShell(term, kernelRef.current, { pkgs: ['git', 'ffmpeg'] });
      return;
    }
    const k = new Kernel();
    await k.boot({ persist: false });
    await bootShell(term, k, { pkgs: ['git', 'ffmpeg'] });
    kernelRef.current = k;
    setKernel(k);
  };

  const box = kernel ? { kernel, env: kernel.getDefaultEnv() } : null;

  return (
    <ShellExample
      title="Git"
      subtitle={
        <>
          Git via <code>lifo-pkg-git</code> — powered by isomorphic-git. Try <code>git clone</code>,{' '}
          <code>git init</code>, <code>git commit</code>, branching, and more. Clone a repo, run it,
          then open Browser to preview.
        </>
      }
      box={box}
      bootTab={(t) => void bootTab(t)}
    />
  );
}
