// A real Chromium for `browser`, over the Chrome DevTools Protocol: Lifo's Browser service (a
// pooled headless Chromium on Lifo Cloud, one browser context per box), or any CDP WebSocket
// endpoint (BROWSER_WS_ENDPOINT, e.g. a Chromium you run yourself).
//
// It runs the same page helpers as the Firefox backend (../firefox/page-helpers.ts), in the page,
// behind a small `gBrowser` shim; navigation, keys, screenshots and `eval` use CDP directly. It
// needs only a WebSocket, so it works in a tab, in Node and in a cloud box (workerd).
import { installHelpers } from '../firefox/page-helpers.js';
import type { PageInfo } from '../firefox/frame.js';

type Json = Record<string, unknown>;
type WebSocketCtor = new (url: string) => {
  readyState: number;
  send(data: string): void;
  close(): void;
  addEventListener(type: string, fn: (ev: { data?: unknown }) => void): void;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** `gBrowser` as page-helpers expects it, backed by the page itself. */
const SHIM = `if (!window.gBrowser) Object.defineProperty(window, 'gBrowser', { configurable: true, enumerable: false, value: {
  selectedBrowser: { get contentDocument() { return document; }, get contentWindow() { return window; },
    webProgress: { get isLoadingDocument() { return document.readyState !== 'complete'; } } },
  currentURI: { get spec() { return location.href; } },
} });`;

/** The helper script, built once: installs window.__bu in a page that doesn't have it yet. */
let installer: string | null = null;
function helperCall(name: string, args: unknown[]): string {
  installer ??= `(function(){ ${SHIM} return (${installHelpers.toString()})(); })`;
  return `(function(){ if (!window.__bu) ${installer}(); return window.__bu.call(${JSON.stringify(name)}, ${JSON.stringify(args)}); })()`;
}

const KEYS: Record<string, { key: string; code: string; keyCode: number; text?: string }> = {
  Enter: { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' },
  Tab: { key: 'Tab', code: 'Tab', keyCode: 9 },
  Escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
  Backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
  Delete: { key: 'Delete', code: 'Delete', keyCode: 46 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
  PageDown: { key: 'PageDown', code: 'PageDown', keyCode: 34 },
  PageUp: { key: 'PageUp', code: 'PageUp', keyCode: 33 },
  Home: { key: 'Home', code: 'Home', keyCode: 36 },
  End: { key: 'End', code: 'End', keyCode: 35 },
  Space: { key: ' ', code: 'Space', keyCode: 32, text: ' ' },
};

export interface ChromiumFrameOptions {
  /** A CDP WebSocket URL, or a function that gets a fresh one (sessions' URLs expire). */
  endpoint: string | (() => Promise<string>);
  /** The WebSocket constructor (defaults to the global one). */
  WebSocket?: WebSocketCtor;
}

/** One CDP connection, flatten sessions. */
class Cdp {
  private ws: InstanceType<WebSocketCtor>;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: Json) => void; reject: (e: Error) => void }>();
  private listeners = new Set<(m: { method: string; params: Json; sessionId?: string }) => void>();
  closed = false;
  readonly open: Promise<void>;

  constructor(url: string, WS: WebSocketCtor) {
    this.ws = new WS(url);
    this.open = new Promise((resolve, reject) => {
      this.ws.addEventListener('open', () => resolve());
      this.ws.addEventListener('error', () => reject(new Error(`can't connect to the browser at ${url.replace(/\/[^/]*$/, '/…')}`)));
    });
    this.ws.addEventListener('message', (ev) => {
      let m: { id?: number; result?: Json; error?: { message: string }; method?: string; params?: Json; sessionId?: string };
      try {
        m = JSON.parse(typeof ev.data === 'string' ? ev.data : new TextDecoder().decode(ev.data as ArrayBuffer));
      } catch {
        return;
      }
      if (m.id != null) {
        const p = this.pending.get(m.id);
        if (!p) return;
        this.pending.delete(m.id);
        if (m.error) p.reject(new Error(m.error.message));
        else p.resolve(m.result ?? {});
      } else if (m.method) {
        for (const l of this.listeners) l({ method: m.method, params: m.params ?? {}, sessionId: m.sessionId });
      }
    });
    this.ws.addEventListener('close', () => {
      this.closed = true;
      for (const p of this.pending.values()) p.reject(new Error('the browser connection closed'));
      this.pending.clear();
    });
  }

  send<T = Json>(method: string, params: Json = {}, sessionId?: string): Promise<T> {
    if (this.closed) return Promise.reject(new Error('the browser connection closed'));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: Json) => void, reject });
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }

  on(fn: (m: { method: string; params: Json; sessionId?: string }) => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  close() {
    this.closed = true;
    try {
      this.ws.close();
    } catch {
      /* already closed */
    }
  }
}

export class ChromiumFrame {
  ready: Promise<void>;
  error: string | null = null;
  private _ready = false;
  private cdp: Cdp | null = null;
  private session = '';
  private opts: ChromiumFrameOptions;

  constructor(opts: ChromiumFrameOptions) {
    this.opts = opts;
    this.ready = this.boot();
    this.ready.catch(() => undefined);
  }

  get isReady() {
    return this._ready;
  }

  private async boot() {
    this._ready = false;
    this.error = null;
    try {
      const WS = this.opts.WebSocket ?? (globalThis as unknown as { WebSocket?: WebSocketCtor }).WebSocket;
      if (!WS) throw new Error('this runtime has no WebSocket');
      const url = typeof this.opts.endpoint === 'string' ? this.opts.endpoint : await this.opts.endpoint();
      const cdp = new Cdp(url, WS);
      await cdp.open;
      this.cdp = cdp;
      // The box's first page, or a new one.
      const { targetInfos } = await cdp.send<{ targetInfos: { targetId: string; type: string }[] }>('Target.getTargets');
      let targetId = targetInfos.find((t) => t.type === 'page')?.targetId;
      if (!targetId) ({ targetId } = await cdp.send<{ targetId: string }>('Target.createTarget', { url: 'about:blank' }));
      const { sessionId } = await cdp.send<{ sessionId: string }>('Target.attachToTarget', { targetId, flatten: true });
      this.session = sessionId;
      await cdp.send('Page.enable', {}, sessionId);
      await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false }, sessionId).catch(() => undefined);
      this._ready = true;
    } catch (e) {
      this.error = (e as Error).message;
      throw e;
    }
  }

  private s<T = Json>(method: string, params: Json = {}) {
    if (!this.cdp) throw new Error(this.error ?? 'the browser is not connected');
    return this.cdp.send<T>(method, params, this.session);
  }

  private async evaluate<T>(expression: string): Promise<T> {
    const r = await this.s<{ result: { value?: T; description?: string }; exceptionDetails?: { text: string; exception?: { description?: string } } }>('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
      userGesture: true,
    });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description?.split('\n')[0] ?? r.exceptionDetails.text);
    return r.result.value as T;
  }

  async call<T = unknown>(name: string, ...args: unknown[]): Promise<T> {
    switch (name) {
      case 'goto': {
        let url = String(args[0] ?? '').trim();
        if (!/^[a-z][a-z0-9+.-]*:/i.test(url)) {
          url = /\s/.test(url) || !/\./.test(url) ? `https://duckduckgo.com/html/?q=${encodeURIComponent(url)}` : `https://${url}`;
        }
        const r = await this.s<{ errorText?: string }>('Page.navigate', { url });
        if (r.errorText && r.errorText !== 'net::ERR_ABORTED') throw new Error(`${url}: ${r.errorText}`);
        return true as T;
      }
      case 'back':
      case 'forward': {
        const h = await this.s<{ currentIndex: number; entries: { id: number }[] }>('Page.getNavigationHistory');
        const e = h.entries[h.currentIndex + (name === 'back' ? -1 : 1)];
        if (e) await this.s('Page.navigateToHistoryEntry', { entryId: e.id });
        return true as T;
      }
      case 'reload':
        await this.s('Page.reload');
        return true as T;
      case 'key': {
        const k = KEYS[String(args[0])] ?? { key: String(args[0]), code: '', keyCode: 0, text: String(args[0]).length === 1 ? String(args[0]) : undefined };
        await this.s('Input.dispatchKeyEvent', { type: k.text ? 'keyDown' : 'rawKeyDown', key: k.key, code: k.code, windowsVirtualKeyCode: k.keyCode, text: k.text });
        await this.s('Input.dispatchKeyEvent', { type: 'keyUp', key: k.key, code: k.code, windowsVirtualKeyCode: k.keyCode });
        return true as T;
      }
      case 'eval': {
        const v = await this.evaluate<unknown>(String(args[0]));
        return (typeof v === 'string' ? v : JSON.stringify(v, null, 2) ?? String(v)) as T;
      }
      case 'screenshot': {
        const full = !!args[0];
        await this.evaluate(helperCall('scroll', ['top'])).catch(() => undefined);
        const m = await this.s<{ cssLayoutViewport: { clientWidth: number; clientHeight: number }; cssContentSize: { height: number } }>('Page.getLayoutMetrics');
        const width = m.cssLayoutViewport.clientWidth;
        const height = full ? Math.min(Math.ceil(m.cssContentSize.height), 12000) : m.cssLayoutViewport.clientHeight;
        const { data } = await this.s<{ data: string }>('Page.captureScreenshot', { format: 'png', captureBeyondViewport: full, ...(full ? { clip: { x: 0, y: 0, width, height, scale: 1 } } : {}) });
        return { dataUrl: `data:image/png;base64,${data}`, width, height } as T;
      }
      default: {
        const raw = await this.evaluate<string>(helperCall(name, args));
        const res = JSON.parse(raw) as { ok: boolean; v?: T; e?: string };
        if (!res.ok) throw new Error(res.e ?? `${name} failed`);
        return res.v as T;
      }
    }
  }

  info(): Promise<PageInfo> {
    return this.call<PageInfo>('info');
  }

  async waitForLoad(before: PageInfo | null, timeoutMs = 30_000, settleMs = 800): Promise<PageInfo> {
    const startedAt = Date.now();
    let sawLoad = false;
    for (;;) {
      let now: PageInfo;
      try {
        now = await this.info();
      } catch {
        // Mid-navigation the page's context can go away for a moment.
        await sleep(150);
        if (Date.now() - startedAt > timeoutMs) throw new Error('the page did not load');
        continue;
      }
      if (now.loading || now.ready === 'loading') sawLoad = true;
      const changed = !before || now.url !== before.url;
      const settled = !now.loading && now.ready === 'complete';
      if (settled && (sawLoad || changed) && Date.now() - startedAt > 150) return now;
      if (settled && !sawLoad && Date.now() - startedAt > settleMs) return now;
      if (Date.now() - startedAt > timeoutMs) return now;
      await sleep(150);
    }
  }

  async restart(): Promise<void> {
    this.cdp?.close();
    this.cdp = null;
    this.ready = this.boot();
    await this.ready;
  }

  close() {
    this.cdp?.close();
    this.cdp = null;
    this._ready = false;
  }
}
