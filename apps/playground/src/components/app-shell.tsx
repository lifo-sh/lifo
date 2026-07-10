import { useCallback, useEffect, useRef, useState } from 'react';
import type { ImperativePanelHandle } from 'react-resizable-panels';
import { Menu, SquareChevronRight } from 'lucide-react';
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable';
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from '@/components/ui/sheet';
import { SidebarNav } from '@/components/sidebar-nav';
import { CodeColumn } from '@/components/code-column';
import { ExampleHost } from '@/components/example-host';
import { OutputChromeProvider } from '@/components/output-chrome';
import { findExample, snippetFor } from '@/examples/registry';
import { useIsMobile } from '@/hooks/use-is-mobile';

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
  // User's Code-column preference (desktop). Examples with no code force it shut.
  const [codeOpen, setCodeOpen] = useState(true);
  const codeVisible = showCode && codeOpen;
  useEffect(() => {
    const p = codePanelRef.current;
    if (!p) return; // no code panel on mobile
    if (codeVisible && p.isCollapsed()) p.expand();
    else if (!codeVisible && !p.isCollapsed()) p.collapse();
  }, [codeVisible, activeId, isMobile]);

  const toggleCode = useCallback(() => setCodeOpen((v) => !v), []);

  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [mobileCodeOpen, setMobileCodeOpen] = useState(false);
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
            onClick={() => setMobileCodeOpen((v) => !v)}
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
            <OutputChromeProvider
              value={{ canToggleCode: !isMobile && showCode, codeOpen, toggleCode }}
            >
              <div className="flex-1 h-full px-2 py-1.5 overflow-hidden flex flex-col min-h-0">
                <ExampleHost activeId={activeId} />
              </div>
            </OutputChromeProvider>
          </ResizablePanel>
        </ResizablePanelGroup>

        {/* Mobile code overlay (desktop uses the code panel above) */}
        {showCode && mobileCodeOpen ? (
          <div className="absolute inset-0 z-20 bg-tokyo-bg-dark lg:hidden">
            <CodeColumn snippet={snippetFor(activeId)} />
          </div>
        ) : null}
      </div>
    </div>
  );
}
