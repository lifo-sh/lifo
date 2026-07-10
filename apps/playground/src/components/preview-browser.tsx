import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, RotateCw, Info, ExternalLink } from 'lucide-react';

interface PreviewBrowserProps {
  /** The box (kernel/sandbox) id — routes /_sw/<boxId>/<port>/ to the right VM. */
  boxId: string;
  /** In-VM virtual port; the iframe loads /_sw/<boxId>/<port>/ through the SW. */
  port: number;
  /** Initial path inside the app (default "/") — e.g. "/_/" for tinbase studio. */
  initialPath?: string;
}

/**
 * Chrome-like browser chrome (back / forward / reload + a pill address bar and
 * open-in-new-tab) wrapping an iframe pointed at /_sw/<boxId>/<port>/. The
 * address bar shows a friendly `localhost:<port>/<path>` — the /_sw/<boxId>
 * service-worker plumbing is hidden. The iframe is a SW-controlled client, so
 * its requests route into the VM; HMR flows through the WebSocket shim.
 */
export function PreviewBrowser({ boxId, port, initialPath = '/' }: PreviewBrowserProps) {
  const path = `/_sw/${boxId}/${port}${initialPath.startsWith('/') ? initialPath : '/' + initialPath}`;
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

  // Friendly URL: strip the /_sw/<boxId>/ prefix so it reads like a normal
  // localhost address; keep the real path for open-in-new-tab.
  let friendlyUrl = `localhost:${port}`;
  let openHref = path;
  try {
    const u = new URL(currentUrl);
    const m = u.pathname.match(/^\/_sw\/[^/]+\/(\d+)(\/.*)?$/);
    const search = u.search.replace(/[?&]_t=\d+/, '').replace(/^\?$/, '');
    if (m) {
      const p = m[2] && m[2] !== '/' ? m[2] : '';
      friendlyUrl = `localhost:${m[1]}${p}${search}`;
    }
    openHref = u.pathname + search;
  } catch {
    // keep defaults
  }

  const back = () => {
    try {
      iframeRef.current?.contentWindow?.history.back();
    } catch {
      /* not ready */
    }
  };
  const forward = () => {
    try {
      iframeRef.current?.contentWindow?.history.forward();
    } catch {
      /* not ready */
    }
  };
  const reload = () => {
    try {
      // Reload in place so the current route survives (deep links keep working).
      iframeRef.current?.contentWindow?.location.reload();
    } catch {
      setNonce((n) => n + 1);
    }
  };

  const navBtn = 'shrink-0 w-7 h-7 grid place-items-center rounded-full bg-transparent border-none text-tokyo-comment hover:text-tokyo-fg-bright hover:bg-tokyo-hover cursor-pointer';

  return (
    <div className="flex flex-col h-full w-full min-h-0 overflow-hidden bg-tokyo-bg">
      <div className="flex items-center gap-1 px-2 py-1.5 border-b border-tokyo-border bg-tokyo-bg-dark">
        <button onClick={back} title="Back" className={navBtn}>
          <ArrowLeft size={16} />
        </button>
        <button onClick={forward} title="Forward" className={navBtn}>
          <ArrowRight size={16} />
        </button>
        <button onClick={reload} title="Reload" className={navBtn}>
          <RotateCw size={14} />
        </button>
        <div className="flex-1 min-w-0 flex items-center gap-2 h-7 px-3 mx-1 rounded-full bg-tokyo-bg">
          <Info size={12} className="shrink-0 text-tokyo-comment" />
          <span className="text-[12.5px] text-tokyo-fg truncate">{friendlyUrl}</span>
        </div>
        <a
          href={openHref}
          target="_blank"
          rel="noopener"
          title="Open in new tab"
          className={navBtn + ' no-underline'}
        >
          <ExternalLink size={14} />
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
