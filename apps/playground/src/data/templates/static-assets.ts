/**
 * A static site served by a small Node server, whose page loads everything by absolute URL:
 * <img src="/images/…">, CSS url(/…), fetch('/data/…'), import('/js/…'), new Worker('/js/…'),
 * a POST to /api/echo and <a href="/about.html">. In the preview the page runs under
 * /_sw/box_…/8080/, and every one of those still reaches the box: the preview's service worker
 * routes a request by the page (or worker) that made it, not by its path. The page checks each
 * one and lists the result, and the server logs every request it gets.
 */

/** A 320×120 gradient, a real binary PNG served as is. */
const GRADIENT_PNG = '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';

function base64Bytes(b64: string): Uint8Array {
	const bin = atob(b64);
	const bytes = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
	return bytes;
}

export function staticAssetsFiles(root: string): Record<string, string | Uint8Array> {
	const files: Record<string, string | Uint8Array> = {};

	files[`${root}/server.js`] = `// A plain static server: public/ as the site root, plus one API route.
// It logs every request, so you can see the paths the browser asks for.
const http = require('http');
const fs = require('fs');
const path = require('path');

const PUBLIC = path.join(__dirname, 'public');
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  console.log(req.method, url.pathname);

  if (url.pathname === '/api/echo' && req.method === 'POST') {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ method: req.method, path: url.pathname, received: JSON.parse(body || '{}') }));
    });
    return;
  }

  let file = path.join(PUBLIC, decodeURIComponent(url.pathname));
  if (!file.startsWith(PUBLIC)) {
    res.writeHead(403);
    res.end();
    return;
  }
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('Not found: ' + url.pathname);
      return;
    }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
}).listen(8080, () => console.log('Serving public/ on http://localhost:8080'));
`;

	files[`${root}/public/index.html`] = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Absolute URLs in a Lifo preview</title>
  <link rel="icon" href="/favicon.svg">
  <link rel="stylesheet" href="/css/site.css">
</head>
<body>
  <header class="banner">
    <img id="logo" src="/images/logo.svg" alt="Logo" width="44" height="44">
    <div>
      <h1>Absolute URLs</h1>
      <p>Every asset on this page is requested by a root-relative URL, like <code>/images/logo.svg</code>.</p>
    </div>
  </header>
  <main>
    <img id="photo" src="/images/gradient.png" alt="A PNG served from the box" width="320" height="120">
    <h2>What loaded</h2>
    <ul id="checks"></ul>
    <p class="hint">
      The preview loads this page from <code>/_sw/box_…/8080/</code>, yet <code>/images/logo.svg</code>
      reaches the box's server, not the playground: the service worker routes each request by the
      page or worker that made it. The server's log in the terminal shows the plain paths it got.
    </p>
    <p><a href="/about.html">Go to /about.html</a> (a link by absolute path)</p>
  </main>
  <script type="module" src="/js/app.js"></script>
</body>
</html>
`;

	files[`${root}/public/about.html`] = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>About</title>
  <link rel="stylesheet" href="/css/site.css">
</head>
<body>
  <header class="banner">
    <img src="/images/logo.svg" alt="Logo" width="44" height="44">
    <h1>About</h1>
  </header>
  <main>
    <p>You followed <code>&lt;a href="/about.html"&gt;</code>. The navigation stayed in the box, and
    this page's stylesheet and logo came from absolute paths too.</p>
    <p><a href="/">Back to /</a></p>
  </main>
</body>
</html>
`;

	files[`${root}/public/css/site.css`] = `/* Loaded by <link href="/css/site.css">. app.js reads --loaded-from to confirm it applied. */
:root {
  --loaded-from: site-css;
  color-scheme: light dark;
}
body {
  margin: 0;
  font-family: system-ui, -apple-system, sans-serif;
  line-height: 1.5;
}
.banner {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 20px 24px;
  color: #fff;
  /* An absolute URL inside CSS. */
  background: #3b4a8c url(/images/pattern.svg) repeat;
}
.banner h1 { margin: 0; font-size: 1.4rem; }
.banner p { margin: 2px 0 0; opacity: 0.85; }
main { padding: 8px 24px 32px; max-width: 760px; }
#photo { display: block; margin: 16px 0; border-radius: 8px; }
#checks { list-style: none; padding: 0; }
#checks li { padding: 4px 0; }
#checks .ok::before { content: '✓ '; color: #2e9e5b; font-weight: 700; }
#checks .fail::before { content: '✗ '; color: #d64545; font-weight: 700; }
#checks small { color: #888; }
.hint { color: #777; font-size: 0.92rem; }
code { font-size: 0.9em; }
`;

	files[`${root}/public/js/app.js`] = `// Loaded by <script type="module" src="/js/app.js">; imports by absolute path too.
import { check, imageLoaded } from '/js/checks.js';

check('<img src="/images/logo.svg">', () => imageLoaded(document.getElementById('logo')));
check('<img src="/images/gradient.png"> (binary)', async () => {
  const img = await imageLoaded(document.getElementById('photo'));
  return img.naturalWidth + '×' + img.naturalHeight;
});
check('<link href="/css/site.css">', () => {
  const value = getComputedStyle(document.documentElement).getPropertyValue('--loaded-from').trim();
  if (value !== 'site-css') throw new Error('stylesheet not applied');
  return 'applied';
});
check('CSS background url(/images/pattern.svg)', async () => {
  const img = new Image();
  img.src = '/images/pattern.svg';
  await imageLoaded(img);
  return 'served';
});
check("fetch('/data/planets.json')", async () => {
  const planets = await (await fetch('/data/planets.json')).json();
  return planets.length + ' planets';
});
check("fetch(new URL('/data/planets.json', location.origin))", async () => {
  const res = await fetch(new URL('/data/planets.json', location.origin));
  return 'HTTP ' + res.status;
});
check("import('/js/lazy.js')", async () => (await import('/js/lazy.js')).message);
check("new Worker('/js/worker.js'), which fetches '/data/planets.json' itself", () => new Promise((resolve, reject) => {
  const worker = new Worker('/js/worker.js');
  worker.onmessage = (e) => (e.data.error ? reject(new Error(e.data.error)) : resolve(e.data.count + ' planets from the worker'));
  worker.onerror = () => reject(new Error('worker failed to load'));
  worker.postMessage('go');
}));
check("POST /api/echo", async () => {
  const res = await fetch('/api/echo', { method: 'POST', body: JSON.stringify({ hello: 'box' }) });
  const body = await res.json();
  return body.method + ' ' + body.path + ' got ' + JSON.stringify(body.received);
});
`;

	files[`${root}/public/js/checks.js`] = `const list = document.getElementById('checks');

/** Runs one check and lists it: a tick with the detail, or a cross with the error. */
export async function check(name, run) {
  const item = document.createElement('li');
  item.textContent = name + ' …';
  list.append(item);
  try {
    const detail = await run();
    item.className = 'ok';
    item.textContent = name + ' ';
    if (typeof detail === 'string') item.append(Object.assign(document.createElement('small'), { textContent: detail }));
  } catch (err) {
    item.className = 'fail';
    item.textContent = name + ' ';
    item.append(Object.assign(document.createElement('small'), { textContent: err.message }));
  }
}

export function imageLoaded(img) {
  return new Promise((resolve, reject) => {
    if (img.complete && img.naturalWidth > 0) return resolve(img);
    img.addEventListener('load', () => resolve(img), { once: true });
    img.addEventListener('error', () => reject(new Error('did not load')), { once: true });
  });
}
`;

	files[`${root}/public/js/lazy.js`] = `export const message = 'loaded on demand';
`;

	files[`${root}/public/js/worker.js`] = `// A worker's own requests are routed by the worker, so absolute URLs work here too.
self.onmessage = async () => {
  try {
    const planets = await (await fetch('/data/planets.json')).json();
    self.postMessage({ count: planets.length });
  } catch (err) {
    self.postMessage({ error: err.message });
  }
};
`;

	files[`${root}/public/data/planets.json`] = JSON.stringify(
		['Mercury', 'Venus', 'Earth', 'Mars', 'Jupiter', 'Saturn', 'Uranus', 'Neptune'],
		null,
		2,
	) + '\n';

	files[`${root}/public/images/logo.svg`] = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48">
  <rect width="48" height="48" rx="12" fill="#fff"/>
  <path d="M15 12h6v18h12v6H15z" fill="#3b4a8c"/>
</svg>
`;

	files[`${root}/public/images/pattern.svg`] = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24">
  <circle cx="4" cy="4" r="1.6" fill="#ffffff" fill-opacity="0.18"/>
  <circle cx="16" cy="16" r="1.6" fill="#ffffff" fill-opacity="0.18"/>
</svg>
`;

	files[`${root}/public/favicon.svg`] = files[`${root}/public/images/logo.svg`];
	files[`${root}/public/images/gradient.png`] = base64Bytes(GRADIENT_PNG);

	return files;
}
