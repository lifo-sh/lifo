import { useEffect, useRef, useState } from 'react';

interface PreviewBrowserProps {
  /** In-VM virtual port; the iframe loads /_sw/<port>/ through the service worker. */
  port: number;
  /** Initial path inside the app (default "/") — e.g. "/_/" for tinbase studio. */
  initialPath?: string;
}

/**
 * Minimal browser chrome (address bar, reload, open-in-new-tab) wrapping an
 * iframe pointed at /_sw/<port>/. The iframe is a SW-controlled client, so its
 * requests route into the VM; HMR flows through the WebSocket shim.
 */
export function PreviewBrowser({ port, initialPath = '/' }: PreviewBrowserProps) {
  const path = `/_sw/${port}${initialPath.startsWith('/') ? initialPath : '/' + initialPath}`;
  const [nonce, setNonce] = useState(0);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [currentUrl, setCurrentUrl] = useState(location.origin + path);

  // The preview is same-origin, so its live URL is readable — but client-side
  // routing (history.pushState, e.g. Expo Router / react-router) fires no event
  // in the parent, so poll. Keeps the address bar and open-in-new-tab honest.
  useEffect(() => {
    const timer = setInterval(() => {
      try {
        const href = iframeRef.current?.contentWindow?.location.href;
        if (href && href !== 'about:blank') setCurrentUrl(href);
      } catch {
        // Not ready or (unexpectedly) cross-origin — keep the last known URL.
      }
    }, 500);
    return () => clearInterval(timer);
  }, []);

  const displayUrl = currentUrl.replace(/[?&]_t=\d+/, '');
  let openHref = path;
  try {
    const u = new URL(currentUrl);
    openHref = u.pathname + u.search.replace(/[?&]_t=\d+/, '');
  } catch {
    // keep the root path
  }

  const reload = () => {
    try {
      // Reload in place so the current route survives (deep links keep working).
      iframeRef.current?.contentWindow?.location.reload();
    } catch {
      setNonce((n) => n + 1);
    }
  };

  return (
    <div className="flex flex-col h-full w-full min-h-0 rounded-lg overflow-hidden border border-tokyo-border bg-tokyo-bg">
      <div className="flex items-center gap-2 px-2 py-1.5 border-b border-tokyo-border bg-tokyo-bg-dark">
        <button
          onClick={reload}
          title="Reload preview"
          className="shrink-0 w-6 h-6 rounded bg-tokyo-hover text-tokyo-muted hover:text-tokyo-fg-bright border-none cursor-pointer"
        >
          ↻
        </button>
        <div className="flex-1 px-2.5 py-1 rounded bg-tokyo-bg text-[11px] font-code text-tokyo-comment truncate">
          {displayUrl}
        </div>
        <a
          href={openHref}
          target="_blank"
          rel="noopener"
          title="Open in new tab"
          className="shrink-0 w-6 h-6 grid place-items-center rounded bg-tokyo-hover text-tokyo-muted hover:text-tokyo-fg-bright no-underline"
        >
          ⧉
        </a>
      </div>
      <iframe
        ref={iframeRef}
        key={nonce}
        src={`${path}?_t=${nonce}`}
        title="Preview"
        className="flex-1 min-h-0 w-full block bg-white border-none"
      />
    </div>
  );
}
