/**
 * Wrap `fetch` so requests to known non-CORS hosts are routed through a CORS
 * proxy the browser CAN reach; every other request passes straight through.
 *
 * The browser VM can't fetch hosts that don't send CORS headers — e.g.
 * api.expo.dev, which create-expo-app and `expo start` call for SDK/native
 * module versions. The proxy base defaults to the local tunnel-server's /_cors
 * endpoint (the stand-in for a hosted Lifo proxy); override with
 * LIFO_CORS_PROXY, and the host allow-list with LIFO_CORS_PROXY_HOSTS
 * (comma-separated).
 *
 * Used by BOTH the node command's injected module-scope `fetch` AND the
 * http/https shim's ClientRequest — CLIs like @expo/cli reach the network via
 * `require('https').request(...)` (fetch-nodeshim), which must proxy the same
 * hosts or the request dies on CORS in the browser.
 */
export function makeProxyingFetch(realFetch: typeof fetch, env: Record<string, string>): typeof fetch {
  const base = env.LIFO_CORS_PROXY || 'http://localhost:3005/_cors?url=';
  const hosts = new Set(
    (env.LIFO_CORS_PROXY_HOSTS || 'api.expo.dev,exp.host,u.expo.dev')
      .split(',').map((h) => h.trim()).filter(Boolean),
  );
  return ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    try {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url;
      if (url && hosts.has(new URL(url).hostname)) {
        return realFetch(base + encodeURIComponent(url), init);
      }
    } catch { /* not a proxyable URL — fall through */ }
    return realFetch(input, init);
  }) as typeof fetch;
}
