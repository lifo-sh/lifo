import { useEffect, useMemo, useState } from 'react';
import { Kernel, type VFS } from '@lifo-sh/core';
import { ExamplePanel } from '@/components/example-panel';
import { TerminalArea } from '@/components/terminal-area';
import { FileExplorerView } from '@/components/file-explorer-view';
import { ResizablePanelGroup, ResizablePanel, ResizableHandle } from '@/components/ui/resizable';
import { createMonacoProvider, setMonacoTheme } from '@/lib/monaco';
import { bootShell } from '@/lib/shell';
import { useTheme } from '@/lib/theme';

function seedExplorerFiles(vfs: VFS) {
  vfs.mkdir('/home/user/projects', { recursive: true });
  vfs.mkdir('/home/user/projects/my-app/src', { recursive: true });
  vfs.writeFile('/home/user/projects/my-app/package.json', JSON.stringify({ name: 'my-app', version: '1.0.0' }, null, 2));
  vfs.writeFile('/home/user/projects/my-app/src/index.ts', 'console.log("Hello from my-app!");\n');
  vfs.writeFile('/home/user/projects/my-app/src/utils.ts', 'export function add(a: number, b: number) {\n  return a + b;\n}\n');
  vfs.writeFile('/home/user/projects/my-app/README.md', '# My App\n\nA sample project.\n');
  vfs.mkdir('/home/user/notes');
  vfs.writeFile('/home/user/notes/todo.txt', '- Try the file explorer\n- Edit some files\n- Create new folders\n');
  vfs.writeFile('/home/user/hello.sh', '#!/bin/sh\necho "Hello, world!"\n');
}

export default function ExplorerExample() {
  const editorProvider = useMemo(() => createMonacoProvider(), []);
  const [kernel, setKernel] = useState<Kernel | null>(null);
  const { mode } = useTheme();

  // Keep Monaco in sync with the app's light/dark toggle.
  useEffect(() => {
    setMonacoTheme(mode);
  }, [mode]);

  useEffect(() => {
    let cancelled = false;
    const k = new Kernel();
    k.boot({ persist: false }).then(() => {
      if (cancelled) return;
      seedExplorerFiles(k.vfs);
      setKernel(k);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const box = kernel ? { kernel, env: kernel.getDefaultEnv() } : null;

  return (
    <ExamplePanel
      title="File Explorer"
      subtitle="Browse and edit the virtual filesystem with a Monaco editor — a terminal below shares the same VFS."
    >
      {kernel ? (
        <ResizablePanelGroup direction="vertical" autoSaveId="pg-explorer-split" className="flex-1 min-h-0">
          <ResizablePanel defaultSize={62} minSize={30}>
            <div className="w-full h-full overflow-hidden">
              <FileExplorerView
                vfs={kernel.vfs}
                cwd="/home/user"
                editorProvider={editorProvider}
                className="w-full h-full"
              />
            </div>
          </ResizablePanel>
          <ResizableHandle className="my-0.5" />
          <ResizablePanel defaultSize={38} minSize={15}>
            <TerminalArea box={box} bootTab={(term) => void bootShell(term, kernel, { pkgs: ['git'] })} />
          </ResizablePanel>
        </ResizablePanelGroup>
      ) : null}
    </ExamplePanel>
  );
}
