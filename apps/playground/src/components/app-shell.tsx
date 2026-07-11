import { useState } from 'react';
import { Menu } from 'lucide-react';
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable';
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from '@/components/ui/sheet';
import { SidebarNav } from '@/components/sidebar-nav';
import { ExampleHost } from '@/components/example-host';
import { OutputChromeProvider } from '@/components/output-chrome';
import { findExample, snippetFor } from '@/examples/registry';
import { useIsMobile } from '@/hooks/use-is-mobile';

/**
 * Layout: Sidebar | Output. The example's code sample is surfaced as a
 * "README.md" tab inside the terminal area (see TerminalArea); the active
 * example's snippet is handed down via OutputChrome. ExampleHost keeps every
 * example's kernel/terminal mounted across switches.
 */
export function App() {
  const [activeId, setActiveId] = useState('interactive');
  const isMobile = useIsMobile();
  const active = findExample(activeId);
  const showCode = !active.hideCode;

  const [sidebarOpen, setSidebarOpen] = useState(false);
  const select = (id: string) => {
    setActiveId(id);
    setSidebarOpen(false);
  };

  return (
    <div className="flex flex-col h-full w-full">
      {/* Mobile header (hidden on desktop) */}
      <header className="flex lg:hidden items-center gap-2 px-4 h-12 bg-tokyo-bg-dark border-b border-tokyo-border shrink-0">
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
      </header>

      <div className="relative flex-1 min-h-0">
        <ResizablePanelGroup direction="horizontal" autoSaveId="pg-cols-v3" className="h-full w-full">
          {!isMobile && (
            <ResizablePanel key="sidebar" id="sidebar" order={1} defaultSize={17} minSize={13} maxSize={26}>
              <SidebarNav activeId={activeId} onSelect={select} />
            </ResizablePanel>
          )}
          {!isMobile && <ResizableHandle key="h1" />}
          <ResizablePanel key="output" id="output" order={2} defaultSize={83} minSize={40}>
            <OutputChromeProvider value={{ snippet: showCode ? snippetFor(activeId) : undefined }}>
              <div className="relative h-full w-full overflow-hidden flex flex-col min-h-0">
                <ExampleHost activeId={activeId} />
              </div>
            </OutputChromeProvider>
          </ResizablePanel>
        </ResizablePanelGroup>
      </div>
    </div>
  );
}
