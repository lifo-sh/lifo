import { type ReactNode, useRef, useState } from 'react';
import { Globe } from 'lucide-react';
import { Panel as RawPanel, type ImperativePanelHandle } from 'react-resizable-panels';
import { ServiceWorkerBridge } from '@lifo-sh/core';
import type { Terminal } from '@lifo-sh/ui';
import { ExamplePanel } from '@/components/example-panel';
import { TerminalArea } from '@/components/terminal-area';
import { UiPreviewBrowser } from '@/components/ui-preview-browser';
import { NoSwPreview } from '@/components/nosw-preview';
import { ResizablePanelGroup, ResizablePanel, ResizableHandle } from '@/components/ui/resizable';
import type { InspectableBox } from '@/lib/process-inspector';

interface ShellExampleProps {
  title: string;
  subtitle?: ReactNode;
  /** The box (null until the first terminal boots). */
  box: InspectableBox | null;
  bootTab: (term: Terminal) => void;
  onRestart?: () => void;
  /** Port the preview address bar starts on (editable in SW mode). Default 5173. */
  defaultPreviewPort?: number;
  /** Initial terminal tab labels, passed through to TerminalArea. */
  initialLabels?: string[];
}

/**
 * A shell example with an on-demand preview browser — for the cases where you
 * clone/scaffold a project and run a dev server, then want to SEE it (e.g. the
 * Interactive Shell, or HTTP Server). Click "Browser" to reveal a preview pane;
 * the SW-backed browser has an editable address bar, and a SW ⇄ postMessage
 * switch lets you fall back to the SW-free transport (for browsers with
 * incomplete service-worker support, e.g. some iOS).
 *
 * The terminal panel stays mounted at all times (the preview panel is what
 * collapses), so toggling the browser never resets the shell/scrollback.
 */
export function ShellExample({ title, subtitle, box, bootTab, onRestart, defaultPreviewPort = 5173, initialLabels }: ShellExampleProps) {
  const [open, setOpen] = useState(false);
  const [boxId, setBoxId] = useState('');
  // null = connecting, true = ready, false = SW unavailable
  const [swReady, setSwReady] = useState<boolean | null>(null);
  const [engine, setEngine] = useState<'sw' | 'postmessage'>('sw');
  const bridgeRef = useRef<ServiceWorkerBridge | null>(null);
  const previewPanelRef = useRef<ImperativePanelHandle>(null);

  // The SW bridge is only needed for the 'sw' engine; create it lazily.
  const initBridge = async () => {
    if (bridgeRef.current || !box) return;
    const bridge = new ServiceWorkerBridge(box.kernel.portRegistry);
    bridgeRef.current = bridge;
    setBoxId(bridge.boxId);
    const ready = await bridge.connect(`${import.meta.env.BASE_URL}sw.js`, '/');
    setSwReady(ready);
  };

  const toggle = () => {
    if (open) {
      previewPanelRef.current?.collapse();
    } else {
      previewPanelRef.current?.expand();
      if (engine === 'sw') void initBridge();
    }
  };

  const switchEngine = () => {
    setEngine((e) => {
      const next = e === 'sw' ? 'postmessage' : 'sw';
      if (next === 'sw') void initBridge();
      return next;
    });
  };

  const headerActions = (
    <div className="flex items-center gap-2">
      {open && (
        <button
          onClick={switchEngine}
          title="Switch preview transport (service worker ⇄ SW-free postMessage)"
          className="h-6 px-2 grid place-items-center rounded bg-tokyo-bg-dark border border-tokyo-border cursor-pointer text-[10px] font-mono text-tokyo-comment hover:text-tokyo-fg-bright"
        >
          preview: {engine === 'sw' ? 'SW' : 'postMessage'}
        </button>
      )}
      <button
        onClick={toggle}
        disabled={!box}
        title={box ? (open ? 'Hide browser' : 'Open browser') : 'Boot a terminal first'}
        className={
          'flex items-center gap-1.5 h-6 px-2 rounded text-[11px] border cursor-pointer ' +
          (open
            ? 'bg-tokyo-bg border-tokyo-blue/50 text-tokyo-blue'
            : 'bg-tokyo-bg-dark border-tokyo-border text-tokyo-comment hover:text-tokyo-fg-bright') +
          (box ? '' : ' opacity-40 cursor-not-allowed')
        }
      >
        <Globe size={13} />
        <span>Browser</span>
      </button>
    </div>
  );

  const terminalArea = <TerminalArea box={box} bootTab={bootTab} onRestart={onRestart} initialLabels={initialLabels} />;

  return (
    <ExamplePanel title={title} subtitle={subtitle} headerAction={headerActions}>
      <ResizablePanelGroup direction="vertical" autoSaveId={`pg-shell-${title}-split`} className="relative flex-1 min-h-0">
        <ResizablePanel defaultSize={100} minSize={20}>
          {terminalArea}
        </ResizablePanel>
        <ResizableHandle className={open ? 'my-0.5' : 'hidden'} />
        <RawPanel
          ref={previewPanelRef}
          collapsible
          collapsedSize={0}
          defaultSize={0}
          minSize={20}
          className="overflow-hidden"
          onCollapse={() => setOpen(false)}
          onExpand={() => setOpen(true)}
        >
          {engine === 'postmessage' ? (
            box ? (
              <NoSwPreview kernel={box.kernel} port={defaultPreviewPort} />
            ) : (
              <div className="flex-1 h-full grid place-items-center text-[12px] text-tokyo-comment">Booting box…</div>
            )
          ) : swReady === false ? (
            <div className="flex-1 h-full grid place-items-center text-center px-4 text-[12px] text-tokyo-comment">
              Service worker unavailable in this browser — switch preview to
              postMessage (top-right).
            </div>
          ) : boxId ? (
            <UiPreviewBrowser boxId={boxId} port={defaultPreviewPort} />
          ) : (
            <div className="flex-1 h-full grid place-items-center text-[12px] text-tokyo-comment">
              Starting preview…
            </div>
          )}
        </RawPanel>
      </ResizablePanelGroup>
    </ExamplePanel>
  );
}
