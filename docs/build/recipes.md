# Recipes

Common things to build with a box, each with a live example in the playground.

## A Vite + React app with a live preview

The pattern behind most "an agent builds an app, the user sees it" products.

1. Build a snapshot with the project's `node_modules` installed (see
   [Shipping a box with your site](files.md#shipping-a-box-with-your-site)).
2. In the page: create a box, import the snapshot, write the generated files into it.
3. Start the dev server in the background and wait for its port:
   `await box.commands.run('cd ~/app && npm run dev &'); await box.waitForPort(5173)`.
4. Show it through a [preview](previews.md). Write later edits with `box.fs.writeFile`; Vite's
   hot reload updates the preview.

If the box runs Vite, set `globalThis.Buffer ??= Buffer` (from `@lifo-sh/core`) in the page
first; see [In the browser](../run/browser.md#with-a-framework).

[Vite with React](https://lifo.sh/playground/index.html?example=vite-react)

## An Expo (React Native) app

Metro, Expo's bundler, is heavy. Lifo includes `browser-metro`, a light bundler for Expo web
apps that serves the app from the box:

```bash
cd ~/my-expo-app
browser-metro --port 8081
```

Show port 8081 in a preview, sized like a phone. `create-expo-app` and the real `expo start`
also run in a box (slower, with more downloads).

[An Expo app](https://lifo.sh/playground/index.html?example=expo)

## A database

**Postgres.** PGlite is Postgres compiled to WebAssembly, and it runs in a box like any npm
package: `npm install @electric-sql/pglite`, then query it from `node`. Give it a directory
(`new PGlite('./pgdata')`) and the database is files in the box, so it's kept in snapshots and
in [cloud boxes](../cloud/boxes.md).

[Postgres with PGlite](https://lifo.sh/playground/index.html?example=pglite)

**A Supabase-compatible backend.** [tinbase](https://tinbase.dev) runs a Supabase-style API
(auth, REST, storage, a studio) in one process. In a box, `supabase start &` runs it (see
[Commands you know](../reference/shell.md#commands-you-know-run-the-lifo-way)) on `http://localhost:54321`, applying the project's
`supabase/migrations` and `seed.sql`. Point the app's Supabase client there.

In a browser tab, the box's tinbase uses its pg-mem engine by default: instant, a few MB, and in
memory, so the database starts again from the migrations and seed every time tinbase starts. For
data that stays in a tab, `supabase start --engine wasm &` runs real Postgres (PGlite) with its
database in the project's `.tinbase/` folder; it takes several hundred MB.

In a [cloud box](../cloud/boxes.md#databases), `supabase start` runs on real Postgres with no
flags: the cloud gives each box its own database (`DATABASE_URL`), outside the box, so data
survives the box sleeping, restarting and being pushed again.

[Supabase with tinbase](https://lifo.sh/playground/index.html?example=tinbase)

## A full-stack app on one URL

A preview, a [tunnel](../cloud/tunnels.md) and a [cloud box](../cloud/boxes.md) each give a box
one port. To put an app and its API behind it, serve both from one server: the page calls the
API on its own origin, and the server proxies the API paths to the backend.

Lifo News is that pattern as a working app: a link board with accounts, posts, votes and comment
threads, built with React and supabase-js on tinbase. Its `server.js` serves the built app and
proxies `/rest/v1` and `/auth/v1` to tinbase:

```bash
supabase start &      # tinbase on :54321
npm start             # the app and its API on :3000
lifo cloud push news --port 3000 --start "supabase start & npm start"
```

The same commands work in the cloud, where tinbase runs on the box's own Postgres database, so
posts are still there after the box sleeps.

It runs on lifo.sh's home page (the Full stack tab, where Run in cloud gives it a URL) and in the
playground. Its `supabase/` folder has the schema with row level security, which tinbase's
Postgres engines enforce (pg-mem skips it).

[Lifo News](https://lifo.sh/playground/index.html?example=news)

## An agent loop

For a model that runs in the visitor's browser, with no API key, see
[An AI agent in the tab](agents.md). For a hosted model, give it one tool, `bash`, backed by a box. The model decides what to run; the box runs it
and returns the output.

```js
import { Sandbox } from '@lifo-sh/core';

const box = await Sandbox.create({ cwd: '/home/user/work' });

const tools = [{
  name: 'bash',
  description: 'Run a shell command in a Linux-like box with node and npm. Returns stdout, stderr and the exit code.',
  input_schema: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
}];

async function runTool(name, input) {
  if (name !== 'bash') throw new Error(`unknown tool ${name}`);
  const { stdout, stderr, exitCode } = await box.commands.run(input.command, { timeout: 60_000 });
  return JSON.stringify({ exitCode, stdout: stdout.slice(-20_000), stderr: stderr.slice(-5_000) });
}

// Your model's tool-use loop: send the conversation and `tools`; for each tool call,
// append runTool(name, input) as the tool result; repeat until the model answers.
```

- Truncate long output before it goes back to the model.
- Register app-specific tools as box commands (`box.commands.register`), so the model calls
  them from the same shell.
- In Node.js a box costs well under a millisecond, so use a fresh one per task.
- A box isn't a security boundary: code the model runs can reach the page or process that
  created the box. Read [Security and isolation](../understand/security.md) first.

lifo.sh's landing page runs this loop entirely in the browser, with a small model on the
visitor's GPU (WebLLM).

## A terminal for a course or tutorial

A [terminal on the page](../run/browser.md#with-a-terminal-on-the-page), a box started from a
snapshot with the lesson's files, and `persist: true` so a learner's work survives a reload.
Check their work with `box.commands.run('node test.js')` and read the result.
