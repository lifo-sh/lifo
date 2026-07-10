import { useEffect, useMemo, useState } from 'react';
import { Kernel } from '@lifo-sh/core';
import { ExamplePanel } from '@/components/example-panel';
import { TerminalView } from '@/components/terminal-view';
import { FileExplorerView } from '@/components/file-explorer-view';
import { ResizablePanelGroup, ResizablePanel, ResizableHandle } from '@/components/ui/resizable';
import { createMonacoProvider } from '@/lib/monaco';
import { bootShell } from '@/lib/shell';

export default function FfmpegExample() {
  const editorProvider = useMemo(() => createMonacoProvider(), []);
  const [kernel, setKernel] = useState<Kernel | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const k = new Kernel();
      await k.boot({ persist: false });
      if (cancelled) return;
      k.vfs.mkdir('/home/user/media', { recursive: true });
      try {
        const resp = await fetch(import.meta.env.BASE_URL + 'sample.mp4');
        if (resp.ok && !cancelled) {
          const buf = await resp.arrayBuffer();
          k.vfs.writeFile('/home/user/media/sample.mp4', new Uint8Array(buf));
        }
      } catch {
        // Sample not available — user can upload via the explorer.
      }
      if (cancelled) return;
      setKernel(k);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <ExamplePanel
      title="FFmpeg"
      subtitle={
        <>
          Transcode media entirely in the browser — try{' '}
          <code>ffmpeg -i sample.mp4 -t 3 out.gif</code> from <code>/home/user/media</code>.
        </>
      }
    >
      {kernel ? (
        <ResizablePanelGroup direction="vertical" autoSaveId="pg-ffmpeg-split" className="flex-1 min-h-0">
          <ResizablePanel defaultSize={62} minSize={30}>
            <div className="w-full h-full rounded-lg overflow-hidden border border-tokyo-border bg-tokyo-bg">
              <FileExplorerView
                vfs={kernel.vfs}
                cwd="/home/user/media"
                editorProvider={editorProvider}
                className="w-full h-full"
              />
            </div>
          </ResizablePanel>
          <ResizableHandle className="my-0.5" />
          <ResizablePanel defaultSize={38} minSize={15}>
            <div className="w-full h-full rounded-lg overflow-hidden border border-tokyo-border bg-tokyo-bg p-2">
              <TerminalView
                className="w-full h-full"
                onReady={(term) => void bootShell(term, kernel, { pkgs: ['git', 'ffmpeg'] })}
              />
            </div>
          </ResizablePanel>
        </ResizablePanelGroup>
      ) : null}
    </ExamplePanel>
  );
}
