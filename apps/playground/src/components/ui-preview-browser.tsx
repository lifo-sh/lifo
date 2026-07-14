import { useEffect, useRef } from 'react';
import { PreviewBrowser } from '@lifo-sh/ui';

interface UiPreviewBrowserProps {
  /** Box id from the SW bridge — routes /_sw/<boxId>/<port>/ to the right VM. */
  boxId: string;
  /** In-VM virtual port the preview points at. */
  port: number;
  /** Initial path inside the app (default "/"). */
  path?: string;
}

/**
 * React wrapper around the framework-agnostic `@lifo-sh/ui` PreviewBrowser (the
 * embeddable component — same one we ship for third parties). Mounts it into a
 * div and tears it down on unmount / prop change. The editable address bar,
 * back/forward/reload, and open-in-new-tab all come from the shared component.
 */
export function UiPreviewBrowser({ boxId, port, path }: UiPreviewBrowserProps) {
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = hostRef.current;
    if (!el || !boxId) return;
    const preview = new PreviewBrowser(el, { boxId, port, path });
    return () => preview.destroy();
  }, [boxId, port, path]);

  return <div ref={hostRef} className="h-full w-full min-h-0" />;
}
