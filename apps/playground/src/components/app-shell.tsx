import { useCallback, useEffect, useState } from 'react';
import { Menu, X } from 'lucide-react';
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable';
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from '@/components/ui/sheet';
import { SidebarNav } from '@/components/sidebar-nav';
import { CodeColumn } from '@/components/code-column';
import { ExampleHost } from '@/components/example-host';
import { OutputChromeProvider } from '@/components/output-chrome';
import { findExample, snippetFor } from '@/examples/registry';
import { useIsMobile } from '@/hooks/use-is-mobile';
import { cn } from '@/lib/utils';

/** Code snippet as a drawer that slides over the output from its left edge. */
function CodeDrawer({ open, snippet, onClose }: { open: boolean; snippet?: string; onClose: () => void }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  return (
    <div
      className={cn(
        'absolute inset-y-0 left-0 z-30 w-full sm:w-[52%] sm:max-w-[560px] flex flex-col bg-tokyo-bg-dark border-r border-tokyo-border shadow-2xl transition-transform duration-200 ease-out',
        open ? 'translate-x-0' : '-translate-x-full pointer-events-none',
      )}
      aria-hidden={!open}
    >
      <div className="flex items-center justify-between h-9 px-3 border-b border-tokyo-border shrink-0">
        <span className="text-[10px] font-semibold uppercase tracking-widest text-tokyo-comment">Code</span>
        <button
          onClick={onClose}
          title="Close code (Esc)"
          className="w-6 h-6 grid place-items-center rounded bg-transparent border-none text-tokyo-comment hover:text-tokyo-fg-bright hover:bg-tokyo-hover cursor-pointer"
        >
          <X size={14} />
        </button>
      </div>
      <div className="flex-1 min-h-0">
        <CodeColumn snippet={snippet} />
      </div>
    </div>
  );
}

/**
 * Layout: Sidebar | Output. The example's Code snippet lives in a drawer that
 * slides over the output from the left (toggled by the navbar ⟨⟩ / mobile Menu),
 * so the terminal + preview get the full width by default. ExampleHost keeps
 * every example's kernel/terminal mounted across switches.
 */
export function App() {
  const [activeId, setActiveId] = useState('interactive');
  const isMobile = useIsMobile();
  const active = findExample(activeId);
  const showCode = !active.hideCode;

  const [codeOpen, setCodeOpen] = useState(false);
  const toggleCode = useCallback(() => setCodeOpen((v) => !v), []);
  // An example with no code can't have the drawer open.
  useEffect(() => {
    if (!showCode) setCodeOpen(false);
  }, [showCode, activeId]);

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
            <OutputChromeProvider value={{ canToggleCode: showCode, codeOpen, toggleCode }}>
              <div className="relative h-full w-full overflow-hidden flex flex-col min-h-0">
                <ExampleHost activeId={activeId} />
                {showCode && (
                  <CodeDrawer open={codeOpen} snippet={snippetFor(activeId)} onClose={() => setCodeOpen(false)} />
                )}
              </div>
            </OutputChromeProvider>
          </ResizablePanel>
        </ResizablePanelGroup>
      </div>
    </div>
  );
}
