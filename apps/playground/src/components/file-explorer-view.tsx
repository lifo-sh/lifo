import { useEffect, useRef } from 'react';
import type { VFS } from '@lifo-sh/core';
import { FileExplorer, type EditorProvider } from '@lifo-sh/ui';

interface FileExplorerViewProps {
  vfs: VFS;
  cwd: string;
  editorProvider: EditorProvider;
  className?: string;
}

/**
 * Imperative FileExplorer wrapper. Creates one FileExplorer on mount (guarded
 * against the accidental double-invoke) and destroys it on unmount.
 */
export function FileExplorerView({ vfs, cwd, editorProvider, className }: FileExplorerViewProps) {
  const ref = useRef<HTMLDivElement>(null);
  const booted = useRef(false);

  useEffect(() => {
    if (booted.current || !ref.current) return;
    booted.current = true;
    const explorer = new FileExplorer(ref.current, vfs, { cwd, editorProvider });
    return () => {
      explorer.destroy();
      booted.current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return <div ref={ref} className={className} />;
}
