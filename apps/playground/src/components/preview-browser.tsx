import { useState } from 'react';

interface PreviewBrowserProps {
  /** In-VM virtual port; the iframe loads /_sw/<port>/ through the service worker. */
  port: number;
}

/**
 * Minimal browser chrome (address bar, reload, open-in-new-tab) wrapping an
 * iframe pointed at /_sw/<port>/. The iframe is a SW-controlled client, so its
 * requests route into the VM; HMR flows through the WebSocket shim.
 */
export function PreviewBrowser({ port }: PreviewBrowserProps) {
  const path = `/_sw/${port}/`;
  const [nonce, setNonce] = useState(0);

  return (
    <div className="flex flex-col flex-1 min-h-0 rounded-lg overflow-hidden border border-tokyo-border bg-tokyo-bg">
      <div className="flex items-center gap-2 px-2 py-1.5 border-b border-tokyo-border bg-tokyo-bg-dark">
        <button
          onClick={() => setNonce((n) => n + 1)}
          title="Reload preview"
          className="shrink-0 w-6 h-6 rounded bg-tokyo-hover text-tokyo-muted hover:text-tokyo-fg-bright border-none cursor-pointer"
        >
          ↻
        </button>
        <div className="flex-1 px-2.5 py-1 rounded bg-tokyo-bg text-[11px] font-code text-tokyo-comment truncate">
          {location.origin + path}
        </div>
        <a
          href={path}
          target="_blank"
          rel="noopener"
          title="Open in new tab"
          className="shrink-0 w-6 h-6 grid place-items-center rounded bg-tokyo-hover text-tokyo-muted hover:text-tokyo-fg-bright no-underline"
        >
          ⧉
        </a>
      </div>
      <iframe
        key={nonce}
        src={`${path}?_t=${nonce}`}
        title="Preview"
        className="flex-1 min-h-0 w-full bg-white border-none"
      />
    </div>
  );
}
