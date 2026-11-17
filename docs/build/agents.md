# An AI agent in the tab

`lifo-pkg-agent` adds two commands to a box:

- `agent "<task>"`: a model runs in the visitor's browser (WebLLM on WebGPU), picks one shell
  command at a time, reads its output and repeats until it can answer. No API key, no model
  server.
- `browser`: a text web browser with browser-use's verbs (`open`, `text`, `state`, `click`,
  `type`), so the agent, or you, can read the web from the shell.

```bash
agent "What is the top story on Hacker News right now?"
```

```text
agent What is the top story on Hacker News right now?
[1] I'll open Hacker News directly.
    $ browser open news.ycombinator.com
    ✓ Hacker News  https://news.ycombinator.com/
[2] I need to read the content to find the top story.
    $ browser text | head -12
    1. Jensen Huang resigns (apnews.com)
    2031 points by lldb 5 hours ago | hide | 2075 comments
[3] The top story is item 1, with its points on the next line.
done in 6.9s with Qwen3.5-2B-q4f16_1-MLC
answer:
The top story is "Jensen Huang resigns" (apnews.com), with 2031 points.
```

The trace goes to stderr and only the answer to stdout, so `agent "…" > answer.txt` keeps just
the answer. Ctrl+C stops it.

[Open the browser agent in the playground](https://lifo.sh/playground/index.html?example=agent)

## Try `browser` on its own

`browser` is registered in every box on lifo.sh. It needs no GPU:

```bash live
browser open news.ycombinator.com
browser text | head -8
browser state | head -6
browser links | grep -i comments | head -3
```

| Command | What it does |
|---|---|
| `browser open <url>` | Load a page. Words that aren't a URL search DuckDuckGo. |
| `browser text` | The page's readable text, a line per block. Pipe it: `browser text \| grep -i price`. |
| `browser state [--all]` | Links, buttons and form fields as `[n]`, 40 at a time. |
| `browser click <n \| text>` | Follow a link, press a submit button, tick a checkbox. |
| `browser type <field> <text> [--enter] [--append]` | Fill a field by number, name, placeholder or label; `--enter` submits its form. |
| `browser select <field> <option>` | Choose an option in a `<select>`. |
| `browser links` | Every link as `text<TAB>url`. |
| `browser scroll [down\|up\|top\|bottom]` | Move the `state` window. |
| `browser back`, `forward`, `reload`, `url`, `title`, `info` | Navigation and page info. |

A target can also be a CSS selector. When text matches more than one element, `browser` lists
them and picks none, so a script never clicks the wrong thing.

No page JavaScript runs. Server-rendered pages read well (news sites, search results,
Wikipedia, docs, most blogs); pages that build themselves in the browser show little, and
`browser` says so. Forms are sent only when they use GET (searches, filters); a POST form is
refused, so the browser can't log in, buy or post anything.

## Add it to your page

```bash
npm install lifo-pkg-agent @lifo-sh/core
```

```js
import { Sandbox } from '@lifo-sh/core';
import { createAgentCommand, createBrowserCommand, webllmEngine } from 'lifo-pkg-agent';

const box = await Sandbox.create({ terminal: '#terminal' });

// Pages load through your server: GET /api/browse?url=… (next section).
box.commands.register('browser', createBrowserCommand());

box.commands.register('agent', createAgentCommand({
  // Run the model in a worker so the page and the terminal stay responsive.
  engine: webllmEngine({
    worker: () => new Worker(new URL('./llm-worker.js', import.meta.url), { type: 'module' }),
  }),
}));
```

```js
// llm-worker.js, next to the file above so your bundler finds it
import 'lifo-pkg-agent/worker';
```

Options for `createAgentCommand`:

| Option | Default | |
|---|---|---|
| `engine` | `webllmEngine()` | Loads the model. Without a worker it runs on the main thread. Pass your own to use another backend. |
| `defaultModel` | `Qwen3.5-2B-q4f16_1-MLC` | Any WebLLM prebuilt model id. `agent models` lists suggestions; `--model` picks one per run. |
| `maxSteps` | 8 | Commands before it must answer; `--steps` overrides it. |
| `prompt` | shell and browser tools | Replace the `intro`, `tools`, `examples` or `rules` of the system prompt. |
| `systemPrompt` | | Replace all of it. |
| `run` | | Runs a command when the shell can't (rare; the agent uses the shell it was started from). |

Options for `createBrowserCommand`: `fetchPage(url, signal)` to load pages your own way
(`proxyFetcher('/my/endpoint')` points it elsewhere), `parseHtml` where there is no
`DOMParser`, and `pageSize` for `state`.

Every reply is constrained to a JSON schema (`{thought, action: "run" | "answer", input}`) at
the token level, which keeps small models on track. The 2B model is about 1.2 GB to download
and needs about 2 GB of GPU memory; `Qwen3.5-4B-q4f16_1-MLC` is steadier on longer tasks.
WebGPU is in current Chrome, Edge and Safari; without it `agent` says so and exits.

## The browse endpoint

A box in a tab can't read other sites directly (CORS), so `browser` asks the page's own server:

```text
GET /api/browse?url=https%3A%2F%2Fnews.ycombinator.com
→ 200 { "url": "https://news.ycombinator.com/", "status": 200, "contentType": "text/html; charset=utf-8", "body": "<html>…" }
→ 4xx/5xx { "error": "refusing 10.0.0.1: not a public address" }
```

`status` is the site's own status (a 404 page is still a 200 answer). `lifo-pkg-agent/proxy`
implements it, with standard `Request` and `Response` objects. In a Next.js route:

```js
// app/api/browse/route.js
import { handleBrowseRequest } from 'lifo-pkg-agent/proxy';

export const runtime = 'nodejs';

export function GET(req) {
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0] ?? 'anonymous';
  return handleBrowseRequest(req, { clientKey: ip });
}
```

An endpoint like this fetches pages on your visitors' behalf, so it is deliberately narrow.
Keep these rules if you write your own:

- **Public addresses only.** Every address a host name resolves to must be public: no
  loopback, private networks, link-local (which includes cloud metadata at 169.254.169.254),
  carrier NAT, multicast, or IPv6 forms that wrap those. The check runs inside the
  connection's own DNS lookup, so a name can't pass the check and then connect somewhere
  else (DNS rebinding). IP literals in any spelling are checked too.
- **Redirects are followed by hand**, at most 5, and each hop is checked again.
- **GET only**, http and https only, ports 80, 443, 8080 and 8443, no `user:pass@` in URLs.
- **No cookies or credentials** either way, and a generic User-Agent.
- **Limits:** 10 seconds in total, 2 MB of body after decompression (cut, and marked
  `truncated`), HTML, plain text and JSON only.
- **Same-site callers only** (`Sec-Fetch-Site`), and a rate limit per client (30 pages a
  minute, in memory per server instance; put a shared limit in front for production traffic).

The playground serves the same endpoint from its Vite dev server when it runs on its own.

## A real Firefox, next to the terminal

On [lifo.sh/agent](https://lifo.sh/agent) (and the landing page's Agent tab, and the playground
example) the terminal sits next to a real Firefox: Gecko compiled to WebAssembly
([firefox-wasm](https://github.com/HeyPuter/firefox-wasm)), ported from the browser-in-browser
experiment. `browser` drives it with the same verbs, plus `key`, `eval`, `screenshot`, `wait`
and `restart`, and the agent's prompt doesn't change. A real engine runs page JavaScript, so
single-page apps work, and you watch every click happen.

```js
import { createBrowserCommand } from 'lifo-pkg-agent';
import { mountFirefox, createFirefoxBrowserCommand } from 'lifo-pkg-agent/firefox';

const firefox = mountFirefox(document.querySelector('#firefox-pane'), {
  wispUrl: async () => (await (await fetch('/api/wisp-token')).json()).url ?? null,
});
// Firefox when it's up; the text browser when it can't run here.
box.commands.register('browser', createFirefoxBrowserCommand(() => firefox, { fallback: createBrowserCommand() }));
```

`browser info` says which one answered. Firefox needs three things the text browser doesn't:

- **The release on your origin.** About 50 MB, served at `/firefox/` on the same origin as the
  page (the page talks to the iframe directly). The website stages it with `pnpm fetch:firefox`
  (downloads the release and patches it to take its relay from `?wisp=` and start on a blank
  page); it isn't committed. The browser caches it after the first visit.
- **Cross-origin isolation.** Gecko's threads need `SharedArrayBuffer`. A full page sends
  `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy`; inside an
  iframe, or in an app like the playground that embeds things COEP would block, Chrome's
  `Document-Isolation-Policy: isolate-and-credentialless` isolates just that document.
  Elsewhere `browser` falls back to text and the pane says why.
- **A network relay.** Firefox opens raw TCP connections (TLS is negotiated inside the tab),
  carried over one WebSocket by a [WISP](https://github.com/MercuryWorkshop/wisp-protocol)
  relay. An open relay is an open TCP proxy, so Lifo's is locked down:

| Rule | |
|---|---|
| Login | `/wisp/<token>/` on the tunnel server, with a token the site mints for a logged-in account (`/api/wisp-token`, 5 minutes) |
| Destinations | TCP to ports 80 and 443 only; loopback, private and link-local addresses refused (after DNS) |
| Per account | 2 relay connections, 32 streams each, closed after 30 minutes (Firefox reconnects with a fresh token) |

Without a login the Firefox pane asks for one and `browser` reads pages as text. Run on its
own, the playground serves `/firefox/` and an unauthenticated relay from its Vite dev server,
which listens on localhost only.

## A real Chromium, on Lifo's Browser service

Where there's no Firefox pane (a cloud box, `lifo-sh`, a Node app), `browser` can drive a real
headless Chromium on Lifo's [Browser service](../cloud/services.md#browser) instead: same verbs,
real page JavaScript, one browser context per box.

```js
import { createBrowserCommand } from 'lifo-pkg-agent';
import { createChromiumBrowserCommand } from 'lifo-pkg-agent/chromium';

// Chromium when BROWSER_WS_ENDPOINT is set or the box has a login (outside a tab); the text
// browser otherwise.
box.commands.register('browser', createChromiumBrowserCommand({ fallback: createBrowserCommand() }));
```

Cloud boxes and `lifo-sh` boxes have this `browser` already. `BROWSER_WS_ENDPOINT` can point at
any CDP endpoint (your own Chromium included), and `LIFO_BROWSER=local|remote|auto` chooses.

## Limits

- Small models are good at short, concrete lookups (a top story, a price, a version number) and
  get lost on long multi-page tasks. Raise `--steps` and try the 4B model for those.
- The model reads only what `browser` prints. With the text browser that means no page
  JavaScript, no images and no POST forms; with Firefox, pages run normally but the model still
  sees text and `state` lists, not pixels.
- Code the agent runs is ordinary box code, with a box's limits: see
  [Security and isolation](../understand/security.md).
