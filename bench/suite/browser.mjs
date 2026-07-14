// Browser benchmark: serve the built core + shared workload over HTTP, load
// them in headless Chromium, and run the same workload as the Node harness —
// plus a "cold module load" (parse+eval of the core bundle) and heap usage.
import http from 'node:http';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, extname } from 'node:path';
import { chromium } from 'playwright';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const CORE_DIST = join(root, 'packages', 'core', 'dist');
const MIME = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.map': 'application/json', '.html': 'text/html', '.json': 'application/json', '.wasm': 'application/wasm' };

const HTML = `<!doctype html><html><head><meta charset="utf-8"></head><body><script type="module">
import { Sandbox } from '/core/index.js';
import { benchBoot, benchCommands, benchFs, WORKLOAD } from '/suite/workload.mjs';
(async () => {
  const boot = await benchBoot(Sandbox, WORKLOAD.bootRuns);
  const sb = await Sandbox.create({ persist: false });
  const commands = await benchCommands(sb, WORKLOAD.cmdOps);
  const fsr = await benchFs(sb, WORKLOAD.fsOps, WORKLOAD.fsSize);
  const heapMB = performance.memory ? +(performance.memory.usedJSHeapSize / 1048576).toFixed(1) : null;
  window.__bench = { boot, commands, fs: fsr, heapMB };
})().catch((e) => { window.__bench = { error: (e && e.stack) || String(e) }; });
</script></body></html>`;

function serve() {
  const server = http.createServer((req, res) => {
    let p = req.url.split('?')[0];
    let file = null;
    if (p === '/' ) { res.setHeader('content-type', 'text/html'); return res.end(HTML); }
    if (p.startsWith('/core/')) file = join(CORE_DIST, p.slice('/core/'.length));
    else if (p.startsWith('/suite/')) file = join(here, p.slice('/suite/'.length));
    if (!file || !fs.existsSync(file)) { res.statusCode = 404; return res.end('nf'); }
    res.setHeader('content-type', MIME[extname(file)] || 'application/octet-stream');
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => server.listen(0, () => resolve({ server, port: server.address().port })));
}

export async function runBrowserBench() {
  const { server, port } = await serve();
  const browser = await chromium.launch({ args: ['--enable-precise-memory-info'] });
  try {
    const page = await browser.newPage();
    // Cold module load: time to fetch+parse+eval the core bundle (localhost, so
    // ~parse+eval; network transfer ≈ the gzipped size).
    await page.goto(`http://localhost:${port}/blank`).catch(() => {});
    await page.setContent('<!doctype html><html><body></body></html>');
    const loadMs = await page.evaluate(async (base) => {
      const t = performance.now();
      await import(base + '/core/index.js');
      return performance.now() - t;
    }, `http://localhost:${port}`);

    await page.goto(`http://localhost:${port}/`);
    await page.waitForFunction(() => window.__bench !== undefined, null, { timeout: 60000 });
    const result = await page.evaluate(() => window.__bench);
    if (result.error) throw new Error('browser bench failed: ' + result.error);
    return { ...result, coreLoadMs: loadMs };
  } finally {
    await browser.close();
    server.close();
  }
}

// Run standalone: `node bench/suite/browser.mjs`
if (import.meta.url === `file://${process.argv[1]}`) {
  runBrowserBench().then((r) => { console.log(JSON.stringify(r, null, 2)); process.exit(0); }).catch((e) => { console.error(e); process.exit(1); });
}
