import { Sandbox } from '@lifo-sh/core';
import { ExamplePanel } from '@/components/example-panel';
import { TerminalView } from '@/components/terminal-view';

export default function NpmExample() {
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
      <div className="w-full rounded-lg overflow-hidden border border-tokyo-border p-2 bg-tokyo-bg flex-1 min-h-0">
        <TerminalView
          className="w-full h-full"
          onReady={(term) => {
            void Sandbox.create({ terminal: term });
          }}
        />
      </div>
    </ExamplePanel>
  );
}
