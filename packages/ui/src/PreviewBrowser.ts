import type { ServiceWorkerBridge } from '@lifo-sh/core';

export interface PreviewBrowserOptions {
  /** In-VM virtual port to preview. */
  port: number;
  /**
   * The box's ServiceWorkerBridge. Its `boxId` is used to route requests
   * (`/_sw/<boxId>/<port>/`) to the right VM. Preferred over `boxId` because it
   * stays correct if you recreate the bridge. Connect the bridge yourself
   * (`await bridge.connect()`) — the preview just points at it.
   */
  bridge?: ServiceWorkerBridge;
  /** An explicit box id, if you manage the service worker yourself. */
  boxId?: string;
  /** Initial path inside the app (default `/`) — e.g. `/_/` for a studio route. */
  path?: string;
  /** Render the browser chrome (back / forward / reload + address bar + open-in-tab). Default `true`. */
  chrome?: boolean;
}

const STYLES = `
.lf-pv { display: flex; flex-direction: column; height: 100%; width: 100%; min-height: 0; overflow: hidden; background: var(--tk-bg, #1a1b26); font-family: ui-sans-serif, system-ui, sans-serif; }
.lf-pv-bar { display: flex; align-items: center; gap: 4px; padding: 6px 8px; border-bottom: 1px solid var(--tk-border, #2f3146); background: var(--tk-bg-dark, #16161e); flex-shrink: 0; }
.lf-pv-btn { flex-shrink: 0; width: 28px; height: 28px; display: grid; place-items: center; border-radius: 9999px; background: transparent; border: none; color: var(--tk-comment, #565f89); cursor: pointer; padding: 0; }
.lf-pv-btn:hover { color: var(--tk-fg-bright, #c0caf5); background: var(--tk-hover, #1e2030); }
.lf-pv-addr { flex: 1; min-width: 0; display: flex; align-items: center; gap: 8px; height: 28px; padding: 0 12px; margin: 0 4px; border-radius: 9999px; background: var(--tk-bg, #1a1b26); }
.lf-pv-addr:focus-within { box-shadow: inset 0 0 0 1px var(--tk-blue, #7aa2f7); }
.lf-pv-addr svg { flex-shrink: 0; color: var(--tk-comment, #565f89); }
.lf-pv-url { flex: 1; min-width: 0; font-size: 12.5px; color: var(--tk-fg, #a9b1d6); background: transparent; border: none; outline: none; padding: 0; font-family: inherit; }
.lf-pv-url:focus { color: var(--tk-fg-bright, #c0caf5); }
.lf-pv-frame { flex: 1; min-height: 0; width: 100%; display: block; background: #fff; border: none; }
.lf-pv-link { text-decoration: none; }
`;

const ICONS = {
  back: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 12H5"/><path d="M12 19l-7-7 7-7"/></svg>',
  forward: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14"/><path d="M12 5l7 7-7 7"/></svg>',
  reload: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M23 4v6h-6"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>',
  info: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/></svg>',
  external: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><path d="M15 3h6v6"/><path d="M10 14L21 3"/></svg>',
};

let stylesInjected = false;
function injectStyles(): void {
  if (stylesInjected || typeof document === 'undefined') return;
  const el = document.createElement('style');
  el.dataset.lifoUi = 'preview-browser';
  el.textContent = STYLES;
  document.head.appendChild(el);
  stylesInjected = true;
}

/**
 * An embeddable preview browser: an `<iframe>` bound to an in-VM port through a
 * `ServiceWorkerBridge`, with optional Chrome-like chrome (back / forward /
 * reload, a friendly `localhost:<port>` address bar, and open-in-new-tab).
 *
 * The iframe is a service-worker-controlled client, so its requests route into
 * the VM and HMR/WebSocket traffic flows through the bridge — a real dev server
 * inside the box renders live here. Framework-agnostic: mount it into any element.
 *
 * ```ts
 * const bridge = new ServiceWorkerBridge(sandbox.kernel.portRegistry);
 * await bridge.connect();
 * const preview = new PreviewBrowser(document.getElementById('preview')!, { bridge, port: 5173 });
 * ```
 */
export class PreviewBrowser {
  private root!: HTMLDivElement;
  private iframe: HTMLIFrameElement;
  private urlEl: HTMLInputElement | null = null;
  private openLink: HTMLAnchorElement | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private nonce = 0;

  private boxId: string;
  private port: number;
  private path: string;
  private currentUrl = '';

  constructor(container: HTMLElement, options: PreviewBrowserOptions) {
    injectStyles();
    this.port = options.port;
    this.boxId = options.bridge?.boxId ?? options.boxId ?? '';
    if (!this.boxId) {
      throw new Error('PreviewBrowser: pass a `bridge` or an explicit `boxId`.');
    }
    const p = options.path ?? '/';
    this.path = p.startsWith('/') ? p : '/' + p;

    const root = document.createElement('div');
    root.className = 'lf-pv';

    const showChrome = options.chrome !== false;
    if (showChrome) root.appendChild(this.buildChrome());

    this.iframe = document.createElement('iframe');
    this.iframe.className = 'lf-pv-frame';
    this.iframe.title = 'Preview';
    this.iframe.src = this.route();
    root.appendChild(this.iframe);

    container.appendChild(root);
    this.root = root;

    if (showChrome) this.startPolling();
  }

  /** The absolute in-VM route the iframe points at (`/_sw/<boxId>/<port>/…`). */
  route(): string {
    return `/_sw/${this.boxId}/${this.port}${this.path}?_t=${this.nonce}`;
  }

  private buildChrome(): HTMLElement {
    const bar = document.createElement('div');
    bar.className = 'lf-pv-bar';

    const mkBtn = (icon: string, title: string, onClick: () => void) => {
      const b = document.createElement('button');
      b.className = 'lf-pv-btn';
      b.title = title;
      b.innerHTML = icon;
      b.addEventListener('click', onClick);
      return b;
    };

    bar.appendChild(mkBtn(ICONS.back, 'Back', () => this.back()));
    bar.appendChild(mkBtn(ICONS.forward, 'Forward', () => this.forward()));
    bar.appendChild(mkBtn(ICONS.reload, 'Reload', () => this.reload()));

    const addr = document.createElement('div');
    addr.className = 'lf-pv-addr';
    addr.innerHTML = ICONS.info;
    const input = document.createElement('input');
    input.className = 'lf-pv-url';
    input.spellcheck = false;
    input.setAttribute('aria-label', 'Address');
    input.value = `localhost:${this.port}`;
    // Editable address bar: type `localhost:5173`, `5173`, `5173/path`, or a
    // bare `/path`, and Enter navigates the preview there.
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        this.applyAddress(input.value);
        input.blur();
      }
    });
    input.addEventListener('focus', () => input.select());
    this.urlEl = input;
    addr.appendChild(input);
    bar.appendChild(addr);

    this.openLink = document.createElement('a');
    this.openLink.className = 'lf-pv-btn lf-pv-link';
    this.openLink.title = 'Open in new tab';
    this.openLink.target = '_blank';
    this.openLink.rel = 'noopener';
    this.openLink.innerHTML = ICONS.external;
    this.openLink.href = this.route();
    bar.appendChild(this.openLink);

    return bar;
  }

  // The preview is same-origin, so its live URL is readable — but client-side
  // routing (history.pushState) fires no event in the parent, so poll to keep
  // the address bar and open-in-new-tab honest.
  private startPolling(): void {
    this.pollTimer = setInterval(() => {
      try {
        const href = this.iframe.contentWindow?.location.href;
        if (href && href !== 'about:blank' && href !== this.currentUrl) {
          this.currentUrl = href;
          this.updateAddress();
        }
      } catch {
        // Not ready — keep the last known URL.
      }
    }, 500);
  }

  private updateAddress(): void {
    if (!this.urlEl) return;
    let friendly = `localhost:${this.port}`;
    let open = this.route();
    try {
      const u = new URL(this.currentUrl);
      const m = u.pathname.match(/^\/_sw\/[^/]+\/(\d+)(\/.*)?$/);
      const search = u.search.replace(/[?&]_t=\d+/, '').replace(/^\?$/, '');
      if (m) {
        const sub = m[2] && m[2] !== '/' ? m[2] : '';
        friendly = `localhost:${m[1]}${sub}${search}`;
      }
      open = u.pathname + search;
    } catch {
      // keep defaults
    }
    // Don't clobber what the user is typing.
    if (document.activeElement !== this.urlEl) this.urlEl.value = friendly;
    if (this.openLink) this.openLink.href = open;
  }

  /**
   * Parse an address the user typed and navigate the preview there. Accepts
   * `localhost:5173`, `5173`, `5173/some/path`, `/some/path`, or a full
   * `http://localhost:5173/...` — the `/_sw/<boxId>/` plumbing is added back.
   */
  private applyAddress(raw: string): void {
    let v = raw.trim().replace(/^https?:\/\//i, '').replace(/^(localhost|127\.0\.0\.1):/i, '');
    const m = v.match(/^(\d+)(\/.*)?$/);
    if (m) {
      this.port = parseInt(m[1], 10);
      this.path = m[2] && m[2] !== '' ? m[2] : '/';
    } else {
      // No port → treat the whole thing as a path on the current port.
      this.path = v === '' ? '/' : v.startsWith('/') ? v : '/' + v;
    }
    this.nonce++;
    this.iframe.src = this.route();
    this.currentUrl = '';
    this.updateAddress();
  }

  back(): void {
    try {
      this.iframe.contentWindow?.history.back();
    } catch { /* not ready */ }
  }

  forward(): void {
    try {
      this.iframe.contentWindow?.history.forward();
    } catch { /* not ready */ }
  }

  /** Reload in place, preserving the current in-app route where possible. */
  reload(): void {
    try {
      this.iframe.contentWindow?.location.reload();
    } catch {
      this.nonce++;
      this.iframe.src = this.route();
    }
  }

  /** Navigate the preview to a new in-VM path (resets to the entry route). */
  navigate(path: string): void {
    this.path = path.startsWith('/') ? path : '/' + path;
    this.nonce++;
    this.iframe.src = this.route();
  }

  /** Point the preview at a different in-VM port. */
  setPort(port: number): void {
    this.port = port;
    this.nonce++;
    this.iframe.src = this.route();
    this.updateAddress();
  }

  destroy(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
    this.root.remove();
  }
}
