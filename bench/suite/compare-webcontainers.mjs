// Head-to-head: boot a StackBlitz WebContainer in headless Chromium and measure
// its cold start + the bytes it downloads, to compare against Lifo's browser
// numbers. WebContainers need cross-origin isolation (COOP/COEP) and fetch their
// runtime from StackBlitz's CDN, so we serve an isolated page and let it load
// `@webcontainer/api` from esm.sh.
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
    // run a trivial command to first output
    const t2 = performance.now();
    const proc = await wc.spawn('jsh', ['-c', 'true']);
    await proc.exit;
    const cmdMs = performance.now() - t2;
    window.__wc = { importedMs, bootMs, cmdMs };
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
  let bytes = 0;
  const pending = [];
  try {
    const page = await browser.newPage();
    // Accurate transfer size (encoded body + headers), including chunked /
    // streamed responses that omit Content-Length — summed on requestfinished.
    page.on('requestfinished', (req) => {
      pending.push(req.sizes().then((s) => { bytes += (s.responseBodySize || 0) + (s.responseHeadersSize || 0); }).catch(() => {}));
    });
    await page.goto(`http://localhost:${port}/`);
    await page.waitForFunction(() => window.__wc !== undefined, null, { timeout: 90000 }).catch(() => {});
    await page.waitForTimeout(2000); // let trailing runtime chunks settle
    await Promise.all(pending);
    const wc = await page.evaluate(() => window.__wc);
    console.log(JSON.stringify({ ...wc, downloadBytes: bytes, downloadMB: +(bytes / 1048576).toFixed(2) }, null, 2));
  } finally {
    await browser.close();
    server.close();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
