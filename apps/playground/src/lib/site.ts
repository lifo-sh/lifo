// The website this playground is framed by, when it's served from a box origin.
//
// lifo.sh can serve this app from a separate "box origin" (a different site) and show it in an
// iframe, so code running in a box (an npm package, an agent's script) can't read lifo.sh's pages
// or reach its cookies. The app then can't call lifo.sh's session endpoints itself; the page that
// frames it names its origin in `?site=<origin>` and answers for the visitor's login instead
// (website: src/components/box-app-frame.tsx):
//
//   window.parent.postMessage({ type: 'lifo-site-ask', what }, site, [port])
//   port ← { type: 'lifo-site-answer', value: string | null }
//
// The message is posted with `site` as its target origin, so the browser delivers it (and the
// port the answer comes back on) only if the parent really is that origin. The site answers only
// its box origin's frame, and only these two questions. Served any other way (on lifo.sh itself,
// or on its own with `pnpm dev`), SITE_ORIGIN is null and the app asks its own server as before.

/** The framing site's origin, or null when this app isn't framed from a box origin. */
export const SITE_ORIGIN: string | null = (() => {
  if (typeof window === 'undefined' || window.parent === window) return null;
  const raw = new URLSearchParams(location.search).get('site');
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    return url.origin === location.origin ? null : url.origin;
  } catch {
    return null;
  }
})();

export type SiteQuestion = 'box-token' | 'wisp-token';

/**
 * Ask the framing site for something that needs the visitor's login: 'box-token' (a one-hour
 * `lifo_tab_` token) or 'wisp-token' (the Firefox relay's URL). Null when logged out, when the
 * site doesn't answer within `timeoutMs`, or when this app isn't framed by a site.
 */
export function askSite(what: SiteQuestion, timeoutMs = 15_000): Promise<string | null> {
  const site = SITE_ORIGIN;
  if (!site) return Promise.resolve(null);
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    const done = (value: string | null) => {
      clearTimeout(timer);
      channel.port1.close();
      resolve(value);
    };
    const timer = setTimeout(() => done(null), timeoutMs);
    channel.port1.onmessage = (event) => {
      const data = event.data as { type?: unknown; value?: unknown } | null;
      if (data?.type === 'lifo-site-answer') done(typeof data.value === 'string' ? data.value : null);
    };
    window.parent.postMessage({ type: 'lifo-site-ask', what }, site, [channel.port2]);
  });
}
