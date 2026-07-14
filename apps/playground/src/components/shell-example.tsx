import { type ReactNode, useRef, useState } from 'react';
import { Globe } from 'lucide-react';
import { Panel as RawPanel, type ImperativePanelHandle } from 'react-resizable-panels';
import { ServiceWorkerBridge } from '@lifo-sh/core';
import type { Terminal } from '@lifo-sh/ui';
import { ExamplePanel } from '@/components/example-panel';
import { TerminalArea } from '@/components/terminal-area';
import { UiPreviewBrowser } from '@/components/ui-preview-browser';
import { ResizablePanelGroup, ResizablePanel, ResizableHandle } from '@/components/ui/resizable';
import type { InspectableBox } from '@/lib/process-inspector';

interface ShellExampleProps {
  title: string;
  subtitle?: ReactNode;
  /** The box (null until the first terminal boots). */
  box: InspectableBox | null;
  bootTab: (term: Terminal) => void;
  onRestart?: () => void;
  /** Port the preview address bar starts on (editable). Default 5173 (Vite). */
  defaultPreviewPort?: number;
}

/**
 * A shell example with an on-demand preview browser — for the cases where you
 * clone/scaffold a project and run a dev server, then want to SEE it (e.g. the
 * Interactive Shell: `git clone … && npm i && npm run dev`). Click "Browser" to
 * reveal a preview pane; the address bar is editable, so point it at whatever
 * port your server picked.
 *
 * The terminal panel stays mounted at all times (the preview panel is what
 * collapses), so toggling the browser never resets the shell/scrollback. The
 * ServiceWorkerBridge is created lazily on first open.
 */
export function ShellExample({ title, subtitle, box, bootTab, onRestart, defaultPreviewPort = 5173 }: ShellExampleProps) {
  const [open, setOpen] = useState(false);
  const [boxId, setBoxId] = useState('');
  // null = connecting, true = ready, false = SW unavailable
  const [swReady, setSwReady] = useState<boolean | null>(null);
  const bridgeRef = useRef<ServiceWorkerBridge | null>(null);
  const previewPanelRef = useRef<ImperativePanelHandle>(null);

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
      void initBridge();
    }
  };

  const browserBtn = (
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
  );

  const terminalArea = <TerminalArea box={box} bootTab={bootTab} onRestart={onRestart} />;

  return (
    <ExamplePanel title={title} subtitle={subtitle} headerAction={browserBtn}>
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
          {swReady === false ? (
            <div className="flex-1 h-full grid place-items-center text-center px-4 text-[12px] text-tokyo-comment">
              Service worker unavailable in this browser — previews need it. Try a
              Chromium-based browser.
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
