import { type ReactNode, useRef, useState } from 'react';
import { PanelTopOpen, PanelTopClose } from 'lucide-react';
import { Panel as RawPanel, type ImperativePanelHandle } from 'react-resizable-panels';
import { Sandbox, ServiceWorkerBridge, pruneExpoModules } from '@lifo-sh/core';
import gitCommand from 'lifo-pkg-git';
import type { Terminal } from '@lifo-sh/ui';
import { ExamplePanel } from '@/components/example-panel';
import { PreviewTabs, type PreviewTab } from '@/components/preview-tabs';
import { NoSwPreview } from '@/components/nosw-preview';
import { TerminalArea } from '@/components/terminal-area';
import { bootShell } from '@/lib/shell';
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
  /** Offer "Prune node_modules" in the box menu (Expo projects) — shrinks the
   *  box to just what Metro needs before snapshotting. */
  pruneable?: boolean;
}

/**
 * Shared shell for "real-world stack" examples: a tabbed terminal area (with a
 * Processes tab and a box menu) over a Chrome-tabbed, service-worker-backed
 * preview, split by a resizable handle. The SW bridge serves /_sw/<boxId>/<port>/
 * so each example routes to its own VM.
 */
export function ProjectExample({ title, subtitle, files, cwd, previewPort, previews, env, pruneable }: ProjectExampleProps) {
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
  // Preview transport: 'sw' (service worker) or 'postmessage' (SW-free blob iframe).
  const [previewEngine, setPreviewEngine] = useState<'sw' | 'postmessage'>('sw');

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
      onPrune={
        pruneable
          ? async () => {
              const sb = sandboxRef.current;
              if (!sb) return;
              try {
                const r = await pruneExpoModules(sb, { onLog: (s) => console.log('[prune]', s) });
                console.log(`[prune] done — kept ${r.after}/${r.before} node_modules files (~${(r.freedBytes / 1048576).toFixed(0)} MB freed). Snapshot now.`);
                alert(`Pruned: kept ${r.after} of ${r.before} node_modules files (~${(r.freedBytes / 1048576).toFixed(0)} MB freed). Snapshot now.`);
              } catch (e) {
                const msg = e instanceof Error ? e.message : String(e);
                console.error('[prune] FAILED:', msg);
                alert(`Prune failed: ${msg}\n\nThe snapshot will be full-size. Make sure the app's web dev server can start (expo start --web).`);
              }
            }
          : undefined
      }
    />
  );

  // Header actions: a preview-engine switch (SW ⇄ postMessage) + the fold toggle.
  const foldToggle = hasPreview ? (
    <div className="flex items-center gap-2">
      <button
        onClick={() => setPreviewEngine((e) => (e === 'sw' ? 'postmessage' : 'sw'))}
        title="Switch preview transport (service worker ⇄ SW-free postMessage)"
        className="h-6 px-2 grid place-items-center rounded bg-tokyo-bg-dark border border-tokyo-border cursor-pointer text-[10px] font-mono text-tokyo-comment hover:text-tokyo-fg-bright"
      >
        preview: {previewEngine === 'sw' ? 'SW' : 'postMessage'}
      </button>
      <button
        onClick={() => (terminalFolded ? termPanelRef.current?.expand() : termPanelRef.current?.collapse())}
        title={terminalFolded ? 'Show terminal' : 'Hide terminal'}
        className="w-6 h-6 grid place-items-center rounded bg-transparent border-none cursor-pointer text-tokyo-comment hover:text-tokyo-fg-bright hover:bg-tokyo-hover"
      >
        {terminalFolded ? <PanelTopOpen size={14} /> : <PanelTopClose size={14} />}
      </button>
    </div>
  ) : undefined;

  return (
    <ExamplePanel title={title} subtitle={subtitle} headerAction={foldToggle}>
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
          <ResizableHandle className={terminalFolded ? 'hidden' : 'my-0.5'} />
          <ResizablePanel defaultSize={55} minSize={20}>
            {previewEngine === 'postmessage' ? (
              sandbox ? (
                <NoSwPreview kernel={sandbox.kernel} port={previewTabs[0]?.port ?? previewPort ?? 8081} />
              ) : (
                <div className="flex-1 h-full grid place-items-center text-[12px] text-tokyo-comment">Booting box…</div>
              )
            ) : swReady === null ? (
              <div className="flex-1 h-full grid place-items-center text-[12px] text-tokyo-comment">
                Starting preview…
              </div>
            ) : swReady ? (
              <PreviewTabs boxId={boxId} tabs={previewTabs} />
            ) : (
              <div className="flex-1 h-full grid place-items-center text-[12px] text-tokyo-comment text-center px-4">
                Service worker unavailable in this browser — switch preview to postMessage (top-right),
                or run the tunnel relay at http://localhost:3005.
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
