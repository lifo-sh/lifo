# Projects: dev, build and start

A project runs the same way in a browser tab, in `lifo-sh` on your machine and on Lifo Cloud.
Lifo reads it once into a **plan**: how to install it, build it, start it, which port it
listens on, and which toolchains it needs. `lifo plan` shows the plan, and `lifo dev`,
`lifo build`, `lifo start` and `lifo cloud push` all run it.

```bash
lifo plan             # what `lifo dev` would run, and why
lifo plan --prod      # what `lifo build` and `lifo start` would run
lifo dev              # install if needed, then the dev server
lifo build            # install if needed, then the production build
lifo start            # the production start (after lifo build)
lifo cloud push web   # built in the cloud, then started for production
```

## Two modes

| | dev | prod |
|---|---|---|
| Runs | install, then the dev command | install, then the build, then the production start |
| Used by | `lifo dev`, `lifo cloud push --dev` | `lifo build`, `lifo start`, `lifo cloud push` |
| Like | `next dev` on your laptop | Next.js on Vercel |

In a box you work in dev mode. Anything that goes to Lifo Cloud uses prod mode unless you
say `--dev`.

## Where the plan comes from

Lifo reads these, each over the one before:

1. **The language.** Today that's JavaScript: `package.json` and the framework it uses. Readers
   for Go, Rust and Python can be added later the same way (`registerProjectReader`).
2. **The Dockerfile**, read as a recipe (below).
3. **`lifo.json`**, which can set any part.

### package.json

| | dev | prod |
|---|---|---|
| install | `npm install`, when there are dependencies and no `node_modules` yet | the same |
| build | none | the `build` script, else the framework's build |
| start | the `dev` script, else the framework's dev command, else the `start` script, else `node server.js` (or `main`, `index.js`, `app.js`) | the `start` script, else the framework's production server, else `node <entry>` |

A `start` script that only starts a dev server (`vite`, `next dev`) isn't used in prod: the
framework's production server is, if it has one.

| Framework | dev | build | production start |
|---|---|---|---|
| Next.js | `next dev` (3000) | `next build` | `next start -p 3000` |
| Vite | `vite` (5173) | `vite build` | `vite preview --port 4173` |
| Astro | `astro dev` (4321) | `astro build` | `astro preview --port 4321` |
| Expo | `expo start` (8081) | none | `expo start` (no production web build in a box yet) |

SvelteKit, React Router, Remix, Nuxt and other frameworks that build with Vite but serve with
their own server use their `start` script. The port comes from `--port`, `-p` or `PORT=` in
the command, else the framework's default. Lifo installs with npm, so a `pnpm-lock.yaml` or
`yarn.lock` is noted and npm installs from `package.json`.

### Dockerfile: a recipe, not an image

Lifo doesn't pull images or run their binaries. It reads what the Dockerfile says and runs
that on its own toolchains, so the same Dockerfile works in a tab, in `lifo-sh` and in the
cloud:

| Instruction | In the plan |
|---|---|
| `FROM node:20` | needs node 20. `python`, `golang`, `rust`, `openjdk`, ... become those needs. `FROM <stage>` follows the stage |
| `WORKDIR` | the project's directory; a deeper one makes later steps `cd` there |
| `COPY`, `ADD` from the build context | nothing: the files are already in the box |
| `COPY --from=<stage>` | a `cp` after the build, or the directory the app starts in (Next.js's `COPY .next/standalone ./`) |
| `ADD <url>` | `curl` in the build |
| `RUN` | a build step. `yarn` and `pnpm` lines run as npm |
| `ENV`, `ARG` | the final stage's `ENV` is the start's environment; earlier stages' is the build's; `${VAR}` is substituted |
| `EXPOSE` | the port |
| `CMD`, `ENTRYPOINT` | the start command |

Some things are left out, and `lifo plan` lists each one with the reason:

- system package installs (`apt-get`, `apk`, `yum`): a Lifo box has no system packages, and a
  container box doesn't keep them across wakes yet;
- `USER`, `chown`, `adduser`: a box has one user;
- `VOLUME`, `HEALTHCHECK`, `LABEL`, `SHELL`, `STOPSIGNAL`;
- heredoc `RUN` steps.

In prod the Dockerfile's build and start win over `package.json`'s: it's your production
recipe. In dev your `dev` script still runs, and only the Dockerfile's toolchain needs apply
(its `EXPOSE 3000` and `NODE_ENV=production` are production's). When nothing but the
Dockerfile describes the project, it's the whole recipe in both modes.

### lifo.json

```json
{
  "install": "npm install",
  "build": ["npm run build", "node scripts/prerender.js"],
  "start": "node server.js",
  "dev": "vite --host",
  "port": 3000,
  "env": { "NODE_ENV": "production" }
}
```

Every field is optional and wins over what Lifo found. `start` is the production start and
`dev` the dev command. `runtime` (`workerd`, `container`) is Lifo Cloud's
([Runtimes](../cloud/boxes.md#runtimes-a-lifo-box-or-a-real-container)).

## Toolchains

A plan lists what it needs (`node`, `python`, `go`, ...). Before running, `lifo dev`, `build`
and `start` check that the box has each one and say plainly when it doesn't:

```
lifo build: This project needs go 1.23 (FROM golang:1.23 in Dockerfile), which isn't in Lifo yet.
```

Python is a package (`lifo install python`). Go, Rust and the others aren't in Lifo yet; their
projects are recognised, so they'll run once the toolchains land, with no change to the project.

## In code

```js
import { planProject, formatPlan } from '@lifo-sh/core';

const plan = planProject(box.kernel.vfs, '/home/user/app', { mode: 'prod' });
plan.install;  // 'npm install'
plan.build;    // ['npm run build']
plan.start;    // 'npm start'
plan.port;     // 3000
plan.needs;    // [{ name: 'node', from: 'package.json' }]
console.log(formatPlan(plan));
```

`planProject` also takes `{ read(path), exists(path) }` instead of a VFS, so it can read a
project on disk or in a snapshot.

## On Lifo Cloud

`lifo cloud push <name>` sends the prod plan. The cloud installs and builds the project in a
builder box of its own, and the box keeps serving its last release until the new one is up. A
build that fails changes nothing. `lifo cloud push <name> --dev` runs the dev command instead,
with no build: useful for a live preview. See [Cloud boxes](../cloud/boxes.md#builds-and-releases).
