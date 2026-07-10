import { type ReactNode, useState } from 'react';
import { Sandbox, ServiceWorkerBridge } from '@lifo-sh/core';
import gitCommand from 'lifo-pkg-git';
import type { Terminal } from '@lifo-sh/ui';
import { ExamplePanel } from '@/components/example-panel';
import { TerminalView } from '@/components/terminal-view';
import { PreviewBrowser } from '@/components/preview-browser';
import { PreviewTabs, type PreviewTab } from '@/components/preview-tabs';
import { ResizablePanelGroup, ResizablePanel, ResizableHandle } from '@/components/ui/resizable';

export interface ProjectExampleProps {
  title: string;
  subtitle: ReactNode;
  /** VFS files to seed into the sandbox. */
  files: Record<string, string>;
  cwd: string;
  /** Virtual port to mount an iframe preview browser for (server examples). */
  previewPort?: number;
  /** Multiple preview tabs (e.g. App + Studio). Takes precedence over previewPort. */
  previews?: PreviewTab[];
  /** Extra env for the sandbox (e.g. Expo-friendly defaults for a stock scaffold). */
  env?: Record<string, string>;
}

/**
 * Shared shell for "real-world stack" examples: a Sandbox terminal (top) over a
 * service-worker-backed preview (bottom), split by a resizable handle. The SW
 * bridge serves /_sw/<port>/ with no host process (last-booted example wins).
 */
export function ProjectExample({ title, subtitle, files, cwd, previewPort, previews, env }: ProjectExampleProps) {
  const hasPreview = !!(previews?.length || previewPort);
  // null = connecting, true = SW ready, false = unavailable
  const [swReady, setSwReady] = useState<boolean | null>(hasPreview ? null : true);

  const bootTerminal = async (term: Terminal) => {
    const sandbox = await Sandbox.create({ terminal: term, files, cwd, env });
    // git in every example shell (create-expo-app scaffolds ask to `git init`).
    sandbox.commands.register('git', gitCommand);

    // No tunnel service here: the service worker below is the browser transport;
    // a relay (ws://localhost:3005) only exists for the CLI, so starting the
    // tunnel in the playground just spams reconnect errors.
    if (!hasPreview) return;

    // Service-worker transport: serve /_sw/<port>/ with no host process.
    const swBridge = new ServiceWorkerBridge(sandbox.kernel.portRegistry);
    const ready = await swBridge.connect(`${import.meta.env.BASE_URL}sw.js`, '/');
    setSwReady(ready);
  };

  const terminalPanel = (
    <div className="w-full h-full rounded-lg overflow-hidden border border-tokyo-border bg-tokyo-bg p-2">
      <TerminalView className="w-full h-full" onReady={(term) => void bootTerminal(term)} />
    </div>
  );

  return (
    <ExamplePanel title={title} subtitle={subtitle}>
      {hasPreview ? (
        <ResizablePanelGroup direction="vertical" autoSaveId={`pg-project-${previews?.[0]?.port ?? previewPort}-split`} className="flex-1 min-h-0">
          <ResizablePanel defaultSize={45} minSize={20}>
            {terminalPanel}
          </ResizablePanel>
          <ResizableHandle className="my-1.5" />
          <ResizablePanel defaultSize={55} minSize={20}>
            {swReady === null ? (
              <div className="flex-1 h-full grid place-items-center text-[12px] text-tokyo-comment">
                Starting preview…
              </div>
            ) : swReady ? (
              previews?.length ? <PreviewTabs tabs={previews} /> : <PreviewBrowser port={previewPort!} />
            ) : (
              <div className="flex-1 h-full grid place-items-center text-[12px] text-tokyo-comment text-center px-4">
                Service worker unavailable in this browser — run the tunnel relay and open
                http://localhost:3005 instead.
              </div>
            )}
          </ResizablePanel>
        </ResizablePanelGroup>
      ) : (
        <div className="flex flex-col flex-1 min-h-0">{terminalPanel}</div>
      )}
    </ExamplePanel>
  );
}
