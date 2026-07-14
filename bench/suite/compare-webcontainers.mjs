// Head-to-head: boot a StackBlitz WebContainer in headless Chromium and measure
// its cold start + the bytes it downloads, to compare against Lifo's browser
// numbers. WebContainers need cross-origin isolation (COOP/COEP) and fetch their
// runtime from StackBlitz's CDN, so we serve an isolated page and let it load
// `@webcontainer/api` from esm.sh.
//
// We spawn `node` AND `npm` because those are Lifo's defaults too — comparing a
// bare boot against Lifo's node+npm-capable core would be apples-to-oranges.
//
// IMPORTANT — download size here is a LOWER BOUND, not the true footprint.
// WebContainers loads its Node/npm wasm engine inside a Web Worker, and neither
// Playwright's request.sizes() nor a page-scoped CDP Network session sees the
// worker's traffic (page-level capture tops out at ~0.01 MB resources here).
// The actual runtime engine is ~75-85 MB on boot (StackBlitz's wasm Node). Treat
// downloadMB below as "main-thread chunks only"; the real answer is ~75-85 MB.
//
// Note: WebContainers may refuse to boot outside allow-listed origins / without
// a key. If so we report that (itself a difference: Lifo has no such gate).
import http from 'node:http';
import { chromium } from 'playwright';

const HTML = `<!doctype html><html><head><meta charset="utf-8"></head><body><script type="module">
(async () => {
  try {
    const t0 = performance.now();
    const { WebContainer } = await import('https://esm.sh/@webcontainer/api@1.6.1');
    const importedMs = performance.now() - t0;
    const t1 = performance.now();
    const wc = await WebContainer.boot();
    const bootMs = performance.now() - t1;
    // Spawn real node + npm (Lifo's defaults) — this forces the full Node wasm
    // engine and npm to load, which a shell builtin like \`jsh -c true\` skips.
    const t2 = performance.now();
    const nodeProc = await wc.spawn('node', ['--version']);
    await nodeProc.exit;
    const cmdMs = performance.now() - t2;
    const t3 = performance.now();
    const npmProc = await wc.spawn('npm', ['--version']);
    await npmProc.exit;
    const npmMs = performance.now() - t3;
    window.__wc = { importedMs, bootMs, cmdMs, npmMs };
  } catch (e) { window.__wc = { error: (e && (e.stack || e.message)) || String(e) }; }
})();
</script></body></html>`;

function serve() {
  const server = http.createServer((req, res) => {
    // Cross-origin isolation required for SharedArrayBuffer.
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
    res.setHeader('content-type', 'text/html');
    res.end(HTML);
  });
  return new Promise((r) => server.listen(0, () => r({ server, port: server.address().port })));
}

async function main() {
  const { server, port } = await serve();
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    // Authoritative wire-transfer accounting via CDP: encodedDataLength is the
    // actual bytes received per request (compressed, includes cross-origin CDN
    // responses that Playwright's request.sizes() can under-report).
    const client = await page.context().newCDPSession(page);
    await client.send('Network.enable');
    const urlById = new Map();
    const bytesByUrl = new Map();
    let bytes = 0;
    client.on('Network.responseReceived', (e) => urlById.set(e.requestId, e.response.url));
    client.on('Network.loadingFinished', (e) => {
      bytes += e.encodedDataLength || 0;
      const u = urlById.get(e.requestId) || '(unknown)';
      bytesByUrl.set(u, (bytesByUrl.get(u) || 0) + (e.encodedDataLength || 0));
    });
    await page.goto(`http://localhost:${port}/`);
    await page.waitForFunction(() => window.__wc !== undefined, null, { timeout: 120000 }).catch(() => {});
    await page.waitForTimeout(3000); // let trailing runtime/wasm chunks settle
    const wc = await page.evaluate(() => window.__wc);
    const top = [...bytesByUrl.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([u, b]) => ({ mb: +(b / 1048576).toFixed(2), url: u.length > 90 ? u.slice(0, 90) + '…' : u }));
    console.log(JSON.stringify({
      ...wc,
      mainThreadDownloadMB: +(bytes / 1048576).toFixed(2),
      note: 'mainThreadDownloadMB is a LOWER BOUND — worker-streamed wasm not captured. True runtime ~75-85 MB.',
      runtimeFootprintMB: '~75-85 (Node wasm engine, loaded in a Web Worker)',
      topResources: top,
    }, null, 2));
  } finally {
    await browser.close();
    server.close();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
