import { useRef, useState } from 'react';
import { Sandbox } from '@lifo-sh/core';
import type { Terminal } from '@lifo-sh/ui';
import { ExamplePanel } from '@/components/example-panel';
import { TerminalArea } from '@/components/terminal-area';
import { bootShell } from '@/lib/shell';
import type { InspectableBox } from '@/lib/process-inspector';

export default function NpmExample() {
  const sandboxRef = useRef<Sandbox | null>(null);
  const [box, setBox] = useState<InspectableBox | null>(null);

  const bootTab = async (term: Terminal) => {
    if (sandboxRef.current) {
      void bootShell(term, sandboxRef.current.kernel, { network: true, pkgs: ['git'] });
      return;
    }
    const sb = await Sandbox.create({ terminal: term });
    sandboxRef.current = sb;
    setBox({ kernel: sb.kernel, env: sb.env });
  };

  return (
    <ExamplePanel
      title="npm"
      subtitle={
        <>
          Install real packages from the npm registry — try{' '}
          <code>npm install cowsay -g &amp;&amp; cowsay hello</code>
        </>
      }
    >
      <TerminalArea box={box} bootTab={(t) => void bootTab(t)} />
    </ExamplePanel>
  );
}
