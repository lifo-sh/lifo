# Services: tools that run on Lifo's servers

A box is small on purpose. It doesn't carry a native ffmpeg, a GPU or a browser engine, and some
jobs are too heavy for a tab anyway. For those, the command stays the same and the work happens
on **Lifo services**: the files the command reads are uploaded, the tool runs in an isolated
container, and what it writes comes back into the box.

> **Preview.** Services are in development. The commands below work against a local service
> today; lifo.sh turns them on when the hosted one launches. Until then they say services
> "aren't available yet".

```bash
lifo login
ffmpeg -i talk.mov -vf scale=1280:-2 -c:v libx264 talk.mp4
#   ffmpeg will run on Lifo Cloud; 1 file (48.2 MB) from this box is uploaded: talk.mov.
#   Allow? [o]nce / [a]lways for your account / [n]o: o
#   ... ffmpeg's own output ...
#   ☁ ffmpeg ran on Lifo Cloud: uploaded 1 file (48.2 MB), 21.40 s CPU, 1 file back
ls            # talk.mov  talk.mp4
```

It is real, native ffmpeg (version 7), not a WebAssembly build: every codec, and many times
faster.


Why some tools are services and others run in the box, and the stand-in each service has in a
tab: [Where the line is](../understand/tab-and-cloud.md#where-the-line-is).

## The tools

| Command | What runs |
|---|---|
| `ffmpeg` | native ffmpeg 7 |
| `ffprobe` | native ffprobe 7 |
| `browser` | a real Chromium (headless, 149), one per box: see [Browser](#browser) |

`lifo services` lists the job tools with their limits. More one-shot tools will follow the same
way; GPU models are planned as sessions, like the browser.

## Browser

`browser` drives a real Chromium for the box: page JavaScript runs, single-page apps work, and
it has the same verbs as the text browser and Firefox (`open`, `state`, `click`, `type`, `text`,
`links`, `eval`, `screenshot`, `key`, `back`, ...). It's attached on first use, with nothing to
set up:

```bash
browser open news.ycombinator.com && browser state
browser click new
browser text | head
browser info        # backend: Chromium on Lifo's Browser service (box "my-api")
```

- **Where it comes from.** In a cloud box, `BROWSER_WS_ENDPOINT` points at the box's own browser
  (`ws://browser.lifo.internal/cdp/<box>`). Under `lifo-sh` or in any box with a login, `browser`
  asks the Browser service for one. In a browser tab the stand-ins answer (the text browser, or
  Firefox where the page has it) unless `LIFO_BROWSER=remote`. `LIFO_BROWSER=local` never uses
  the service.
- **It's the box's.** Each box gets its own browser context: its own tabs, cookies and storage,
  which no other box (yours or anyone's) can see. Tabs stay open between commands and close by
  themselves after 5 idle minutes, or when a cloud box goes to sleep.
- **Bring your own tools.** It's plain CDP, so `playwright-core` and `puppeteer` connect to the
  same endpoint, in a cloud box too:

  ```js
  import { chromium } from 'playwright-core';
  const browser = await chromium.connectOverCDP(process.env.BROWSER_WS_ENDPOINT);
  const page = browser.contexts()[0].pages()[0] ?? (await browser.contexts()[0].newPage());
  ```

  Outside a cloud box, get an endpoint from code: `(await LifoServices.connect({ token })).browserSession('my-box')`
  returns `{ wsEndpoint, screencastUrl }` (the URL is good for 5 minutes to connect).
- **Any CDP endpoint.** Set `BROWSER_WS_ENDPOINT` to your own Chromium's WebSocket
  (`chrome --remote-debugging-port`) and `browser` drives that instead.
- **Network.** Pages reach the public internet only: loopback, private ranges and cloud metadata
  addresses are refused, and so are `file://` and `chrome://` URLs. Nothing leaves your box but
  the URLs you open (no files are uploaded), so `browser` doesn't ask first.
- **Limits (preview):** browsers for 3 boxes at once per account, 8 tabs per box, sessions up to 60
  minutes (reconnect for more), and one Chromium per account capped at 1 GB.

## Your files, and asking first

Lifo runs in your browser so your files stay with you. A service is the exception, so it is
never silent:

- **What is sent**: the command's arguments, and the files it names that exist in the box (its
  inputs). Nothing else from the box. An output file that already exists isn't sent.
- **It asks the first time**, per tool: *once* (this run), *always* (your account, in every
  box), or *no*.
- **Scripts and agents** can't answer a prompt, so the command stops and says how to allow it:

  ```bash
  lifo services allow ffmpeg            # this box
  lifo services allow ffmpeg --always   # your account
  LIFO_SERVICES_ALLOW=ffmpeg ffmpeg ... # one run (or "all")
  lifo services deny ffmpeg             # ask again
  ```

- **On the server**: each job runs in its own container with no network and nothing mounted but
  its own files, which are deleted when it ends. Inputs and results are kept for a day, per
  account, so a second run doesn't upload the same file again and you can fetch a result;
  then they're deleted. No other account can read them.

## Where a command runs

`LIFO_EXEC` chooses:

| | |
|---|---|
| `auto` (default) | in the box when the box has its own version of the tool and the input is small; otherwise the service |
| `local` | only in the box. The command fails rather than upload anything |
| `remote` | always the service |

A box gets its own version of a tool from a package, `lifo install ffmpeg` (ffmpeg.wasm: slower and
fewer codecs, but nothing leaves the box; inputs up to 25 MB then stay local), or from your code:

```js
import { Sandbox, setLocalTool } from '@lifo-sh/core';

const box = await Sandbox.create();
setLocalTool(box.kernel.vfs, 'ffmpeg', {
  maxBytes: 10 * 1024 * 1024,           // bigger inputs go to the service
  command: async (ctx) => { /* run ffmpeg.wasm with ctx.args, ctx.vfs */ return 0; },
});
```

## How paths work

The job sees a folder that mirrors your working directory: `in.wav` and `out/tone.mp3` mean the
same there. Files elsewhere in the box (`/data/a.mov`, `../b.mov`) work too; they're mapped in
and their results mapped back. Two limits:

- A path written *inside* another argument (a filter such as `movie=logo.png`) isn't seen, so
  that file isn't uploaded. Keep such files next to the command and name them as arguments
  where the tool allows it.
- Network inputs (`-i https://...`) are refused: jobs have no network. Download with `curl`
  first.

**Pipes carry text.** `ffprobe ... | jq` works. Binary data through a pipe
(`ffmpeg ... -f mp3 - > out.mp3`) doesn't survive a box's shell; write to a file instead.

## Limits during the preview

- 120 s per job, 1 CPU, 1 GB of memory.
- 200 MB of input and 200 MB of output per job; 2 jobs at once.
- A job that goes over is stopped and the command says why (exit code 124 for time, 137 for
  memory or size).

`lifo services usage` shows this month's jobs, CPU time and transfer. Nothing is billed during
the preview.

## From code

```js
import { LifoServices } from '@lifo-sh/core';

const services = await LifoServices.connect({ token: 'lifo_...' });   // an API key from the dashboard
const result = await services.run({
  tool: 'ffmpeg',
  args: ['-i', 'in.wav', '-b:a', '64k', 'out.mp3'],
  files: [{ path: 'in.wav', bytes: wavBytes }],
  onStderr: (bytes) => process.stderr.write(bytes),
});
// { exitCode: 0, files: [{ path: 'out.mp3', sha256, size }], usage: { cpuMs, wallMs, ... }, uploaded }
const mp3 = await services.download(result.files[0].sha256);
```

`run` uploads only the files the service doesn't already have (by SHA-256), and `signal` (an
`AbortSignal`) cancels the job.

## The API

HTTP with a `lifo_` key as a bearer token. Its address comes from the account server's
`/api/cli/config` (`servicesUrl`), or `LIFO_SERVICES_URL`.

| | |
|---|---|
| `GET /v1/tools` | `{ tools: [{ name, version, description, limits }], consent: { tools } }` |
| `GET /v1/consent`, `PUT /v1/consent` | `{ tools }` this account always allows |
| `POST /v1/blobs/check` | `{ hashes }` returns `{ missing }` |
| `PUT /v1/blobs/:sha256` | upload one file |
| `GET /v1/blobs/:sha256` | download a result |
| `POST /v1/jobs` | `{ tool, args, files: [{ path, sha256 }], dirs?, stdin?: { sha256 }, version? }`; the response streams one JSON event per line: `start`, `o`/`e` (base64 stdout/stderr), `file`, `exit` |
| `DELETE /v1/jobs/:id` | cancel |
| `GET /v1/usage` | `{ from, to, totals, tools }` |
| `POST /v1/browser/sessions` | `{ box, state?: { cookies } }` returns `{ box, wsEndpoint, screencastUrl, expiresAt, version, limits }` |
| `GET /v1/browser/sessions` | the account's Chromium and its boxes' browsers |
| `GET` / `PUT /v1/browser/sessions/:box/state` | the box browser's cookies, to save and restore |
| `DELETE /v1/browser/sessions/:box` | close the box's browser |
| `WS /v1/browser/cdp/:token` | CDP (the `wsEndpoint`) |
| `WS /v1/browser/screencast/:token` | JPEG frames out, mouse, keys and navigation in |
| `GET /v1/browser/usage` | the browser's share of this month's usage |
