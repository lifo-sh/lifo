---
'@lifo-sh/core': minor
'lifo-sh': minor
---

One plan for a project, run the same way in a tab, in lifo-sh and on Lifo Cloud (docs/build/projects.md).

- core: `planProject()` reads a project into a plan (install, build, start, port, env, the toolchains it needs) from `package.json` and its framework (Next.js, Vite, Astro, Expo), a `Dockerfile` read as a recipe rather than an image, and `lifo.json`. Two modes: `dev` (the dev server) and `prod` (build, then the production start). Language readers are pluggable (`registerProjectReader`) so Go, Rust and Python can follow.
- `lifo plan`, `lifo dev`, `lifo build` and `lifo start` in every box. A project whose toolchain the box lacks is refused with its name (`needs go 1.23 (FROM golang:1.23 in Dockerfile)`).
- `lifo cloud push` sends the production plan by default: Lifo Cloud builds it in a builder box and keeps the last release serving until the new one is up. `--dev` pushes the dev command instead; `--no-build` skips the build; `lifo cloud logs <name> --build`. `LifoCloud` gets `builds()`, `build()` and `followBuild()`.
- `npm ci` (installs from package.json, as `npm install` does).
- `npm run` and other commands that run a shell line now stop it on Ctrl+C.
- core: `http.Server.listen()` takes the port as Node does: a numeric string (`listen(process.env.PORT)`) or `{ port }`. A string used to register the server under the wrong key, so nothing answered on that port.
