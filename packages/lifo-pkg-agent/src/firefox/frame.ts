// Boots Firefox (Gecko compiled to WebAssembly, github.com/HeyPuter/firefox-wasm) in a same-origin
// iframe and exposes a small RPC over its window.geckoEvalChrome hook, which runs JS in Firefox's
// privileged chrome context. Ported from the browser-in-browser experiment.
//
// Requirements (see docs/build/agents.md):
//   - the release staged at `firefoxUrl` (default /firefox/) on this page's origin, patched to take
//     its relay from ?wisp= (website: `pnpm fetch:firefox`);
//   - cross-origin isolation (Gecko's threads need SharedArrayBuffer): this page and /firefox/ are
//     served with COOP + COEP, or Document-Isolation-Policy inside an iframe (Chrome);
//   - a WISP relay: Gecko brings its own TCP/TLS stack and tunnels raw TCP over one WebSocket.
import { installHelpers } from './page-helpers.js';

type GeckoWindow = Window & { geckoEvalChrome?: (js: string) => Promise<string> };

export interface PageInfo {
  url: string;
  title: string;
  loading: boolean;
  ready: string;
  scrollY: number;
  viewport: number;
  height: number;
}

export type FirefoxStatus = 'booting' | 'ready' | 'error';

export interface FirefoxFrameOptions {
  /** Where the patched release is served, same origin. Default '/firefox/'. */
  firefoxUrl?: string;
  /**
   * The relay to use, asked before every boot (tokens are short-lived). Return null when there is
   * none (e.g. not logged in); the boot then fails with `noRelayMessage`.
   */
  wispUrl: () => string | null | Promise<string | null>;
  noRelayMessage?: string;
  onStatus?: (text: string, state: FirefoxStatus) => void;
}

/** True when this page can run Firefox (SharedArrayBuffer, i.e. cross-origin isolated). */
export function canRunFirefox(): boolean {
  return typeof window !== 'undefined' && (window as Window & { crossOriginIsolated?: boolean }).crossOriginIsolated === true;
}

export class FirefoxFrame {
  ready: Promise<void>;
  /** Why the last boot failed, if it did. */
  error: string | null = null;
  private readonly firefoxUrl: string;
  private readonly onStatus: (text: string, state: FirefoxStatus) => void;
  private relayRetries = 0;
  private win: GeckoWindow | null = null;
  private installed = false;
  /** True once Firefox has booted and the page helpers are installed. */
  isReady = false;
  /** Set when the WISP relay socket dropped (e.g. the server restarted). Gecko never reconnects. */
  relayLost = false;
  private generation = 0;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly frame: HTMLIFrameElement,
    private readonly opts: FirefoxFrameOptions,
  ) {
    this.firefoxUrl = (opts.firefoxUrl ?? '/firefox/').replace(/\/?$/, '/');
    this.onStatus = opts.onStatus ?? (() => {});
    this.ready = this.start();
  }

  /** Reboots Firefox from scratch (fresh engine, fresh relay connection). */
  restart(): Promise<void> {
    this.ready = this.start();
    return this.ready;
  }

  private start(): Promise<void> {
    const p = this.boot().catch((e: Error) => {
      this.error = e.message;
      this.onStatus(e.message, 'error');
      throw e;
    });
    p.catch(() => {}); // callers that never await `ready` shouldn't see an unhandled rejection
    return p;
  }

  private async boot() {
    const gen = ++this.generation;
    this.isReady = false;
    this.installed = false;
    this.relayLost = false;
    this.error = null;
    this.win = null;
    this.queue = Promise.resolve();
    if (!canRunFirefox()) throw new Error('this page is not cross-origin isolated, so Firefox (which needs SharedArrayBuffer) cannot run here');
    const wisp = await this.opts.wispUrl();
    if (!wisp) throw new Error(this.opts.noRelayMessage ?? 'no network relay for Firefox');
    this.onStatus('loading Firefox…', 'booting');
    const loaded = new Promise<void>((resolve) => this.frame.addEventListener('load', () => resolve(), { once: true }));
    this.frame.src = `${this.firefoxUrl}index.html?home=about:blank&boot=${gen}&wisp=${encodeURIComponent(wisp)}`;
    await loaded;
    const win = this.frame.contentWindow as GeckoWindow;
    const doc = this.frame.contentDocument!;
    this.watchRelay(win, gen);

    // Press the demo's Start button, then mirror its progress until the engine exposes its hook.
    // The button stays disabled until the demo has fetched Firefox's front-end assets.
    const start = await poll(() => {
      const btn = doc.getElementById('start-btn') as HTMLButtonElement | null;
      const pct = doc.querySelector('[aria-valuenow]')?.getAttribute('aria-valuenow');
      if (pct) this.onStatus(`downloading Firefox… ${pct}%`, 'booting');
      return btn && !btn.disabled ? btn : null;
    }, 300_000, 200);
    this.onStatus('starting Firefox…', 'booting');
    await preparePrivateProfile();
    start.click();
    await poll(() => (typeof win.geckoEvalChrome === 'function' ? true : null), 300_000, 250);
    this.win = win;
    // The chrome window keeps finishing its startup for a moment after the hook appears.
    await poll(async () => ((await win.geckoEvalChrome!('typeof gBrowser')) === 'object' ? true : null), 60_000, 250);
    await this.install();
    await this.evalChrome(PRIVACY_PREFS);
    this.isReady = true;
    this.relayRetries = 0;
    if (!this.relayLost) this.onStatus('ready', 'ready');
  }

  /**
   * Gecko opens its WISP relay WebSocket on the iframe's main thread and never reconnects it. Wrap the
   * iframe's WebSocket constructor to notice when that socket drops, then reboot Firefox as soon as
   * the server answers again, so a server restart doesn't leave a browser that can't load anything.
   */
  private watchRelay(win: Window, gen: number) {
    const Native = (win as Window & typeof globalThis).WebSocket;
    const onLost = () => this.onRelayLost(gen);
    (win as Window & typeof globalThis).WebSocket = class extends Native {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols);
        if (String(url).includes('/wisp')) this.addEventListener('close', onLost);
      }
    };
  }

  private async onRelayLost(gen: number) {
    if (gen !== this.generation || this.relayLost) return; // a socket from an old boot closing
    this.relayLost = true;
    if (this.relayRetries >= 5) {
      this.onStatus('network relay disconnected; `browser restart` tries again', 'error');
      return;
    }
    const wait = 2000 * 2 ** this.relayRetries++;
    this.onStatus(`network relay disconnected, reconnecting in ${Math.round(wait / 1000)} s…`, 'error');
    await sleep(wait);
    if (gen !== this.generation) return;
    await this.restart().catch(() => {});
  }

  private async install() {
    const res = await this.evalChrome(`(${installHelpers.toString()})()`);
    if (res !== 'installed') throw new Error(`could not install page helpers: ${res || 'no result'}`);
    this.installed = true;
  }


  /**
   * evalChrome with two fixes: calls are serialized, and long scripts are sent in chunks. The engine
   * passes the script through a fixed-size command buffer (somewhere between 8 and 16 KB) and
   * silently returns "" for anything longer, so big scripts are accumulated in a chrome-side buffer
   * first and evaluated from there.
   */
  evalChrome(js: string): Promise<string> {
    const run = async () => {
      const ev = this.win!.geckoEvalChrome!;
      if (js.length <= 6000) return ev(js);
      await ev('window.__bu_buf = ""; "ok"');
      for (let i = 0; i < js.length; i += 2500) {
        await ev(`window.__bu_buf += ${JSON.stringify(js.slice(i, i + 2500))}; "ok"`);
      }
      // browser.xhtml's CSP blocks eval()/Function(), so evaluate in a system-principal sandbox whose
      // prototype is the chrome window (same globals: gBrowser, Services, …; not bound by the CSP).
      return ev(
        '(() => { const s = window.__bu_buf; delete window.__bu_buf;' +
          ' const sb = Cu.Sandbox(Services.scriptSecurityManager.getSystemPrincipal(), { sandboxPrototype: window, wantXrays: false });' +
          ' return String(Cu.evalInSandbox(s, sb)); })()',
      );
    };
    const result = this.queue.then(run, run);
    this.queue = result.catch(() => undefined);
    return result;
  }

  /** Calls a helper from page-helpers.ts inside Firefox. Throws with the helper's error message. */
  async call<T = unknown>(name: string, ...args: unknown[]): Promise<T> {
    await this.ready;
    if (this.relayLost && (name === 'goto' || name === 'reload')) {
      throw new Error('the network relay is disconnected; Firefox restarts by itself once the server is back (or run `browser restart`)');
    }
    const js = `window.__bu ? window.__bu.call(${JSON.stringify(name)}, ${JSON.stringify(args)}) : "__missing__"`;
    let raw = await this.evalChrome(js);
    if (raw === '__missing__' || !this.installed) {
      await this.install();
      raw = await this.evalChrome(js);
    }
    if (!raw) throw new Error(`${name}: no response from Firefox`);
    const res = JSON.parse(raw) as { ok: boolean; v?: T; e?: string };
    if (!res.ok) throw new Error(res.e);
    return res.v as T;
  }

  info() {
    return this.call<PageInfo>('info');
  }

  /**
   * Waits for a navigation started by the last action to finish. If nothing starts loading within
   * `settleMs`, the action did not navigate and this returns right away.
   */
  async waitForLoad(before: PageInfo | null, timeoutMs = 30_000, settleMs = 800): Promise<PageInfo> {
    const startedAt = Date.now();
    let sawLoad = false;
    for (;;) {
      const now = await this.info();
      if (now.loading || now.ready === 'loading') sawLoad = true;
      const changed = !before || now.url !== before.url;
      const settled = !now.loading && now.ready === 'complete';
      if (settled && (sawLoad || changed) && Date.now() - startedAt > 150) return now;
      if (settled && !sawLoad && Date.now() - startedAt > settleMs) return now;
      if (Date.now() - startedAt > timeoutMs) return now;
      await sleep(200);
    }
  }
}

// Firefox's profile lives in this origin's OPFS under "profile/" (the demo's `profile` option) and is
// shared by every tab. Delete the saved session before each boot, otherwise Firefox reopens whatever
// the last session had open (e.g. developer.puter.com from the demo's old start page).
async function preparePrivateProfile() {
  try {
    const profile = await (await navigator.storage.getDirectory()).getDirectoryHandle('profile', { create: true });
    for (const name of ['sessionstore.jsonlz4', 'sessionstore-backups', 'user.js']) {
      await profile.removeEntry(name, { recursive: true }).catch(() => undefined);
    }
  } catch (e) {
    console.warn('[firefox] could not prepare the profile:', e);
  }
}

// This build ignores profile/user.js, so privacy prefs are set at runtime once the chrome is up: no
// session restore, a blank start page, no network geolocation/region lookups, no telemetry.
const PRIVACY_PREFS = `(() => {
  const p = Services.prefs;
  p.setIntPref("browser.startup.page", 0);
  p.setStringPref("browser.startup.homepage", "about:blank");
  p.setBoolPref("browser.sessionstore.resume_from_crash", false);
  p.setBoolPref("browser.newtabpage.enabled", false);
  p.setStringPref("geo.provider.network.url", "");
  p.setStringPref("browser.region.network.url", "");
  p.setBoolPref("browser.region.update.enabled", false);
  p.setBoolPref("datareporting.healthreport.uploadEnabled", false);
  p.setBoolPref("toolkit.telemetry.enabled", false);
  return "ok";
})()`;

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function poll<T>(fn: () => T | null | undefined | Promise<T | null | undefined>, timeoutMs: number, everyMs = 100) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    try {
      const v = await fn();
      if (v) return v;
    } catch {
      /* not ready yet */
    }
    if (Date.now() > end) throw new Error('timed out waiting for Firefox');
    await sleep(everyMs);
  }
}
