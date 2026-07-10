/**
 * Server-side CORS proxy — the browser VM can't fetch hosts that don't send
 * CORS headers (e.g. api.expo.dev, which create-expo-app / `expo start` hit for
 * SDK + native-module versions). Whatever hosts the playground page proxies the
 * request server-side and returns it with permissive CORS headers.
 *
 * Runtime-agnostic core (Web Fetch API): the Vite dev middleware and the
 * production Next.js route both delegate here, so dev and prod behave
 * identically and neither needs the standalone tunnel relay running.
 *
 * Kept intentionally small and safe: GET/HEAD/POST/OPTIONS only, http(s) only.
 */

const CORS_HEADERS: Record<string, string> = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET,POST,OPTIONS',
  'access-control-allow-headers': '*',
};

/** Handle a `/_cors?url=<encoded>` request. `req` is a standard Web Request. */
export async function handleCorsProxy(req: Request): Promise<Response> {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  const target = new URL(req.url).searchParams.get('url');
  if (!target) {
    return new Response('missing url param', { status: 400, headers: CORS_HEADERS });
  }

  let parsed: URL;
  try {
    parsed = new URL(target);
  } catch {
    return new Response('invalid url', { status: 400, headers: CORS_HEADERS });
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return new Response('unsupported protocol', { status: 400, headers: CORS_HEADERS });
  }

  try {
    const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
    const upstream = await fetch(target, {
      method: req.method,
      headers: {
        accept: req.headers.get('accept') || '*/*',
        'user-agent': req.headers.get('user-agent') || 'lifo',
        ...(req.headers.get('content-type') ? { 'content-type': req.headers.get('content-type')! } : {}),
      },
      body: hasBody ? await req.arrayBuffer() : undefined,
    });
    const body = await upstream.arrayBuffer();
    return new Response(body, {
      status: upstream.status,
      headers: {
        ...CORS_HEADERS,
        'content-type': upstream.headers.get('content-type') || 'application/octet-stream',
      },
    });
  } catch (e) {
    return new Response('cors proxy error: ' + (e instanceof Error ? e.message : String(e)), {
      status: 502,
      headers: CORS_HEADERS,
    });
  }
}
