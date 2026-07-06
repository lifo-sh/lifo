import { Kernel } from '@lifo-sh/core';
import { ExamplePanel } from '@/components/example-panel';
import { TerminalView } from '@/components/terminal-view';
import { bootShell } from '@/lib/shell';

export default function GitExample() {
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
      <div className="w-full rounded-lg overflow-hidden border border-tokyo-border p-2 bg-tokyo-bg flex-1 min-h-0">
        <TerminalView
          className="w-full h-full"
          onReady={async (term) => {
            const kernel = new Kernel();
            await kernel.boot({ persist: false });
            await bootShell(term, kernel, { pkgs: ['git', 'ffmpeg'] });
          }}
        />
      </div>
    </ExamplePanel>
  );
}
