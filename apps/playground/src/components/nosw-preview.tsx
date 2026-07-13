import { useEffect, useRef, useState } from 'react';
import type { Kernel } from '@lifo-sh/core';
import { mountNoSwPreview, type NoSwPreviewHandle } from '@/lib/preview-nosw';

/**
 * Service-worker-FREE preview: renders an in-VM dev-server app in a blob iframe,
 * tunnelling its requests/HMR to the host over postMessage. Alternative to the
 * SW-backed PreviewBrowser for environments where SWs are unreliable (iOS).
 */
export function NoSwPreview({ kernel, port }: { kernel: Kernel; port: number }) {
  const ref = useRef<HTMLIFrameElement>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');

  useEffect(() => {
    let handle: NoSwPreviewHandle | null = null;
    let cancelled = false;
    const el = ref.current;
    if (el) {
      setStatus('loading');
      mountNoSwPreview(el, kernel, port)
        .then((h) => { if (cancelled) h.destroy(); else { handle = h; setStatus('ready'); } })
        .catch(() => { if (!cancelled) setStatus('error'); });
    }
    return () => { cancelled = true; handle?.destroy(); };
  }, [kernel, port]);

  return (
    <div className="relative flex-1 h-full min-h-0">
      {status === 'loading' && (
        <div className="absolute inset-0 grid place-items-center text-[12px] text-tokyo-comment pointer-events-none">
          Starting SW-free preview… (run the dev server in the terminal)
        </div>
      )}
      {status === 'error' && (
        <div className="absolute inset-0 grid place-items-center text-[12px] text-tokyo-red px-4 text-center">
          Preview failed to start.
        </div>
      )}
      <iframe
        ref={ref}
        className="w-full h-full border-0 bg-white"
        sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals"
        title="preview"
      />
    </div>
  );
}
