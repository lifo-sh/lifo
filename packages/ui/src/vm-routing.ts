/**
 * vm-routing.ts — which in-VM port serves a given URL.
 *
 * This is the one place the routing rules live. It is a plain function with no
 * imports and no closure captures, which matters: the preview shim inlines it
 * into the iframe via `Function.prototype.toString()` (see preview-shims.ts), so
 * the code that runs inside the sandboxed document and the code under unit test
 * are literally the same function. It used to be duplicated as an escaped string
 * inside a template literal, where the regex needed `\\/` and nothing could be
 * tested without slicing the generated source apart.
 *
 * Keep it dependency-free and ES5-ish for that reason.
 */

export interface VmTarget {
  /** In-VM virtual port that should serve the request. */
  port: number;
  /** Path + query as that server should see it (SW prefixes stripped). */
  path: string;
}

/**
 * Resolve `url` to the in-VM port that serves it, or `null` when it should go to
 * the real network.
 *
 * A preview is not a single server: an Expo app on 8081 talks to a tinbase
 * backend on 54321 in the same box, and tinbase's studio is a third surface on
 * that same port. Callers pass the preview port as the default for anything
 * relative.
 *
 * @param url         The URL as the app wrote it (may be relative).
 * @param previewPort Port backing the preview document itself.
 * @param hostOrigin  Origin of the EMBEDDING page, e.g. `https://lifo.sh` or
 *                    `http://localhost:5173`, captured in the parent document
 *                    and passed in.
 *
 *                    It must be passed in rather than read here: inside a
 *                    `blob:` document `location.host` is the empty string (only
 *                    `location.origin` survives), so a check against
 *                    `location.host` silently rejects every non-loopback
 *                    embedder. That made an app's absolute
 *                    `https://<site>/_sw/<port>/…` URL skip the tunnel in
 *                    production while working locally, where the embedder
 *                    happens to be loopback.
 *
 *                    Two things depend on knowing it: a URL on the embedder's
 *                    own origin is same-origin (so a `/_sw/` prefix on it is
 *                    ours to route), and without a prefix it is the embedder's
 *                    own asset and must reach the real network.
 */
export function resolveVmTarget(
  url: unknown,
  previewPort: number,
  hostOrigin: string,
): VmTarget | null {
  if (!url) return null;
  const raw = String(url);
  if (/^(blob:|data:)/.test(raw)) return null;

  // Declared INSIDE the function on purpose: this whole function is stringified
  // into the preview document, so a module-level constant would become a free
  // variable that doesn't exist there (and a minifier would rename it anyway).
  // Nothing here may reference anything outside this function body.
  //
  // The service worker's URL scheme, honoured off the SW path too so an app
  // written for it keeps working with no service worker present:
  //   /_sw/<boxId>/<port>/<path>   box explicit (iframe entry URLs)
  //   /_sw/<port>/<path>           this box, sibling service
  // The second form is why an Expo app can ship
  // EXPO_PUBLIC_SUPABASE_URL=/_sw/54321 and reach tinbase unmodified. boxIds are
  // `box_<alnum>`, so they never collide with a numeric port.
  const swPrefix = /^\/_sw\/(?:box_[A-Za-z0-9]+\/)?(\d+)(\/.*)?$/;

  const direct = raw.match(swPrefix);
  if (direct) return { port: Number(direct[1]), path: direct[2] || '/' };

  if (raw.charAt(0) === '/') return { port: previewPort, path: raw };

  let parsed: URL;
  try {
    // Resolve against the preview's own origin: in a blob document
    // location.href is a blob: URL with no useful host or path.
    parsed = new URL(raw, 'http://localhost:' + previewPort + '/');
  } catch {
    return null;
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;

  const loopback = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1';

  // Is this the page doing the embedding? Compared by host, so the scheme and any
  // default port don't matter.
  let hostHost = '';
  try {
    hostHost = hostOrigin ? new URL(hostOrigin).host : '';
  } catch {
    hostHost = '';
  }
  const isEmbedder = hostHost !== '' && parsed.host === hostHost;

  // A genuinely foreign origin is never in-VM, whatever its path says.
  if (!loopback && !isEmbedder) return null;

  // An explicit /_sw/<port>/ prefix is an unambiguous routing instruction, so it
  // is honoured BEFORE the embedder-port exclusion below.
  //
  // This ordering is the whole ballgame for a blob: preview. React Native needs
  // absolute URLs, so an app resolves its configured `/_sw/54321` against
  // `location.origin` — which inside a blob document is the EMBEDDER's origin.
  // The app therefore requests `http://localhost:5173/_sw/54321/rest/v1/todos`.
  // Excluding the embedder's port first made that fall through to the real
  // network, where a registered service worker would answer it: the SW-free
  // preview silently depended on a service worker, which is exactly what it
  // exists to avoid (iOS Chrome has no dependable one).
  const nested = parsed.pathname.match(swPrefix);
  if (nested) return { port: Number(nested[1]), path: (nested[2] || '/') + parsed.search };

  // The embedding page's own origin is not an in-VM port. Its assets and its
  // CORS proxy must reach the real network.
  if (isEmbedder) return null;

  return {
    port: loopback && parsed.port ? Number(parsed.port) : previewPort,
    path: parsed.pathname + parsed.search,
  };
}
