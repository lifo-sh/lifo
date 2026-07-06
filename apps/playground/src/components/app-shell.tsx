import { useEffect, useRef, useState } from 'react';
import type { ImperativePanelHandle } from 'react-resizable-panels';
import { Menu, SquareChevronRight } from 'lucide-react';
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable';
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from '@/components/ui/sheet';
import { SidebarNav } from '@/components/sidebar-nav';
import { CodeColumn } from '@/components/code-column';
import { ExampleHost } from '@/components/example-host';
import { findExample, snippetFor } from '@/examples/registry';
import { useIsMobile } from '@/hooks/use-is-mobile';

function OutputHeader() {
  return (
    <div className="px-4 py-2.5 border-b border-tokyo-border shrink-0 hidden lg:block">
      <div className="text-[10px] font-semibold uppercase tracking-widest text-tokyo-comment">Output</div>
    </div>
  );
}

/**
 * Single layout tree for both breakpoints. The `ResizablePanelGroup` and the
 * output panel (which holds every example's live kernel/terminal via
 * ExampleHost) are ALWAYS mounted; only the sidebar/code panels are conditional
 * (react-resizable-panels supports conditional panels via id/order). This keeps
 * terminals alive when the window crosses the mobile/desktop breakpoint — a
 * two-tree layout would unmount and destroy them.
 */
export function App() {
  const [activeId, setActiveId] = useState('interactive');
  const isMobile = useIsMobile();
  const active = findExample(activeId);
  const showCode = !active.hideCode;

  const codePanelRef = useRef<ImperativePanelHandle>(null);
  useEffect(() => {
    const p = codePanelRef.current;
    if (!p) return; // no code panel on mobile
    if (showCode && p.isCollapsed()) p.expand();
    else if (!showCode && !p.isCollapsed()) p.collapse();
  }, [showCode, activeId, isMobile]);

  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [codeOpen, setCodeOpen] = useState(false);
  const select = (id: string) => {
    setActiveId(id);
    setSidebarOpen(false);
  };

  return (
    <div className="flex flex-col h-full w-full">
      {/* Mobile header (hidden on desktop) */}
      <header className="flex lg:hidden items-center justify-between px-4 h-12 bg-tokyo-bg-dark border-b border-tokyo-border shrink-0">
        <Sheet open={sidebarOpen} onOpenChange={setSidebarOpen}>
          <SheetTrigger className="flex items-center gap-2 text-tokyo-muted text-sm">
            <Menu className="size-4" />
            <span className="font-semibold text-tokyo-fg-bright">Lifo</span>
          </SheetTrigger>
          <SheetContent side="left" className="w-[240px] p-0 bg-tokyo-bg-dark border-tokyo-border">
            <SheetTitle className="sr-only">Examples</SheetTitle>
            <SidebarNav activeId={activeId} onSelect={select} />
          </SheetContent>
        </Sheet>
        {showCode ? (
          <button
            onClick={() => setCodeOpen((v) => !v)}
            className="flex items-center gap-1.5 text-tokyo-muted text-xs px-2.5 py-1 rounded-md border border-tokyo-border hover:text-tokyo-fg-bright"
          >
            <SquareChevronRight className="size-3.5" /> Code
          </button>
        ) : null}
      </header>

      <div className="relative flex-1 min-h-0">
        <ResizablePanelGroup direction="horizontal" autoSaveId="pg-cols-v2" className="h-full w-full">
          {!isMobile && (
            <ResizablePanel key="sidebar" id="sidebar" order={1} defaultSize={17} minSize={13} maxSize={26}>
              <SidebarNav activeId={activeId} onSelect={select} />
            </ResizablePanel>
          )}
          {!isMobile && <ResizableHandle key="h1" />}
          {!isMobile && (
            <ResizablePanel
              key="code"
              id="code"
              order={2}
              ref={codePanelRef}
              collapsible
              collapsedSize={0}
              minSize={22}
              defaultSize={33}
              className="border-r border-tokyo-border"
            >
              <CodeColumn snippet={snippetFor(activeId)} />
            </ResizablePanel>
          )}
          {!isMobile && <ResizableHandle key="h2" />}
          <ResizablePanel key="output" id="output" order={3} defaultSize={50} minSize={30}>
            <div className="flex flex-col h-full min-h-0">
              <OutputHeader />
              <div className="flex-1 p-4 overflow-hidden flex flex-col min-h-0">
                <ExampleHost activeId={activeId} />
              </div>
            </div>
          </ResizablePanel>
        </ResizablePanelGroup>

        {/* Mobile code overlay (desktop uses the code panel above) */}
        {showCode && codeOpen ? (
          <div className="absolute inset-0 z-20 bg-tokyo-bg p-4 lg:hidden">
            <CodeColumn snippet={snippetFor(activeId)} />
          </div>
        ) : null}
      </div>
    </div>
  );
}
