import { type ReactNode, useRef, useState } from 'react';
import { PanelTopOpen } from 'lucide-react';
import { Panel as RawPanel, type ImperativePanelHandle } from 'react-resizable-panels';
import { Sandbox, ServiceWorkerBridge } from '@lifo-sh/core';
import gitCommand from 'lifo-pkg-git';
import type { Terminal } from '@lifo-sh/ui';
import { ExamplePanel } from '@/components/example-panel';
import { PreviewTabs, type PreviewTab } from '@/components/preview-tabs';
import { TerminalArea } from '@/components/terminal-area';
import { bootShell } from '@/lib/shell';
import { downloadSnapshot, pickAndRestoreSnapshot } from '@/lib/box-snapshot';
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
 * Shared shell for "real-world stack" examples: a tabbed terminal area (with a
 * Processes tab and a box menu) over a Chrome-tabbed, service-worker-backed
 * preview, split by a resizable handle. The SW bridge serves /_sw/<boxId>/<port>/
 * so each example routes to its own VM.
 */
export function ProjectExample({ title, subtitle, files, cwd, previewPort, previews, env }: ProjectExampleProps) {
  const hasPreview = !!(previews?.length || previewPort);
  // Always present the preview as Chrome-like tabs, even for a single port.
  const previewTabs: PreviewTab[] = previews?.length
    ? previews
    : previewPort
      ? [{ label: 'Preview', port: previewPort }]
      : [];

  // null = connecting, true = SW ready, false = unavailable
  const [swReady, setSwReady] = useState<boolean | null>(hasPreview ? null : true);
  // Box id from the SW bridge — routes /_sw/<boxId>/<port>/ to THIS example's VM.
  const [boxId, setBoxId] = useState<string>('');
  const [sandbox, setSandbox] = useState<Sandbox | null>(null);
  // Bumping this remounts the terminal area → a fresh terminal 0 → new sandbox.
  const [bootNonce, setBootNonce] = useState(0);

  const sandboxRef = useRef<Sandbox | null>(null);
  const bridgeRef = useRef<ServiceWorkerBridge | null>(null);

  // Fold/unfold the terminal panel (preview examples). The terminal panel is
  // *collapsed* (size 0), never unmounted, so the box/kernel/scrollback survive.
  const termPanelRef = useRef<ImperativePanelHandle>(null);
  const [terminalFolded, setTerminalFolded] = useState(false);

  // The first terminal creates the Sandbox + SW bridge; extra terminals attach
  // a shell onto the shared kernel.
  const bootFirstTerminal = async (term: Terminal) => {
    // Point the VM's fetch CORS-proxy at this same origin — a /_cors endpoint
    // served by the Vite dev middleware locally and by the Next.js site in
    // production. Caller env wins if it sets LIFO_CORS_PROXY.
    const sb = await Sandbox.create({
      terminal: term,
      files,
      cwd,
      env: { LIFO_CORS_PROXY: `${location.origin}/_cors?url=`, ...env },
    });
    sb.commands.register('git', gitCommand);
    sandboxRef.current = sb;
    setSandbox(sb);

    if (!hasPreview) return;
    const swBridge = new ServiceWorkerBridge(sb.kernel.portRegistry);
    bridgeRef.current = swBridge;
    setBoxId(swBridge.boxId);
    const ready = await swBridge.connect(`${import.meta.env.BASE_URL}sw.js`, '/');
    setSwReady(ready);
  };

  const bootExtraTerminal = (term: Terminal) => {
    const sb = sandboxRef.current;
    if (!sb) return;
    void bootShell(term, sb.kernel, {
      network: true,
      pkgs: ['git'],
      cwd,
      env: { LIFO_CORS_PROXY: `${location.origin}/_cors?url=`, ...env },
    });
  };

  const restart = () => {
    // Reboot the box: tear down the SW bridge + sandbox and remount the terminal
    // area, which recreates the sandbox from the ORIGINAL seeded files.
    bridgeRef.current?.destroy();
    bridgeRef.current = null;
    sandboxRef.current?.destroy();
    sandboxRef.current = null;
    setSandbox(null);
    setBoxId('');
    setSwReady(hasPreview ? null : true);
    setBootNonce((n) => n + 1);
  };

  const box = sandbox ? { kernel: sandbox.kernel, env: sandbox.env } : null;
  const terminalArea = (
    <TerminalArea
      key={bootNonce}
      box={box}
      bootTab={(term) => {
        // The "+" is gated on `box`, so the first terminal always boots alone
        // and creates the sandbox; later terminals attach to its kernel.
        if (sandboxRef.current) bootExtraTerminal(term);
        else void bootFirstTerminal(term);
      }}
      onRestart={restart}
      onSnapshot={sandbox ? () => downloadSnapshot(sandbox) : undefined}
      onRestore={sandbox ? () => pickAndRestoreSnapshot(sandbox) : undefined}
      onFold={hasPreview ? () => termPanelRef.current?.collapse() : undefined}
    />
  );

  return (
    <ExamplePanel title={title} subtitle={subtitle}>
      {hasPreview ? (
        <ResizablePanelGroup
          direction="vertical"
          autoSaveId={`pg-project-${previewTabs[0]?.port ?? previewPort}-split`}
          className="relative flex-1 min-h-0"
        >
          <RawPanel
            ref={termPanelRef}
            collapsible
            collapsedSize={0}
            defaultSize={45}
            minSize={20}
            className="overflow-hidden"
            onCollapse={() => setTerminalFolded(true)}
            onExpand={() => setTerminalFolded(false)}
          >
            {terminalArea}
          </RawPanel>
          <ResizableHandle className="my-0.5" />
          {/* When the terminal is folded, a slim bar to bring it back */}
          {terminalFolded && (
            <button
              onClick={() => termPanelRef.current?.expand()}
              title="Show terminal"
              className="absolute top-0 left-0 right-0 z-20 flex items-center justify-center gap-1.5 h-6 text-[11px] text-tokyo-comment bg-tokyo-bg-dark border-b border-tokyo-border hover:text-tokyo-fg-bright cursor-pointer"
            >
              <PanelTopOpen size={13} />
              Show terminal
            </button>
          )}
          <ResizablePanel defaultSize={55} minSize={20}>
            {swReady === null ? (
              <div className="flex-1 h-full grid place-items-center text-[12px] text-tokyo-comment">
                Starting preview…
              </div>
            ) : swReady ? (
              <PreviewTabs boxId={boxId} tabs={previewTabs} />
            ) : (
              <div className="flex-1 h-full grid place-items-center text-[12px] text-tokyo-comment text-center px-4">
                Service worker unavailable in this browser — run the tunnel relay and open
                http://localhost:3005 instead.
              </div>
            )}
          </ResizablePanel>
        </ResizablePanelGroup>
      ) : (
        <div className="flex flex-col flex-1 min-h-0">{terminalArea}</div>
      )}
    </ExamplePanel>
  );
}
