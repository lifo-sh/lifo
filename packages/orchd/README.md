# orchd

Run a project from the `orchd.json` that ships inside it — on your machine, in
Docker, or in a [Lifo](https://lifo.sh) box.

```bash
npx orchd up          # or: npm install -g orchd
```

[ORCHD](https://github.com/RapidNative/cloud) provisions per-project workloads
across substrates. The same `orchd.json` describes all of them and travels *with*
the project (inside a repo, a snapshot, a tarball, or an image), so whatever
boots the project can read one file instead of being handed a command line.

## One package, two runners

| where | how it runs | what starts a workload |
| --- | --- | --- |
| your machine / CI / Docker | the `orchd` bin | a real child process |
| inside a Lifo box | the `orchd` command | a job in the Lifo shell |

Both sit on the same pure resolution layer (`orchd`'s main export), so `resolve`
answers identically in either place — only execution differs.

In a box the command registers itself through the `lifo.commands` field in
`package.json`, which lifo keys on by *manifest field*, not by package name. So:

```bash
lifo install orchd    # in a box
npm install -g orchd  # on a host
```

…install the same package. Embedders can import the box command directly:

```ts
import orchdCommand from 'orchd/lifo';
sandbox.commands.register('orchd', orchdCommand);
```

**Profiles are not applied unless a runner asks for one.** On a host you get the
project's ordinary commands (`npm run dev`, `expo start --web`); the in-box
command defaults to `--profile lifo`. That is the whole point of profiles — see
below.

## Usage

```
orchd list                            list workloads in the manifest
orchd resolve [options]               print the resolved command line
orchd run [options]                   resolve, then run it
orchd up [options]                    start every workload, each on its own port

  -w, --workload <name>   workload to act on (default: the only one, if unambiguous)
  -p, --port <n>          port to bind; substituted for $PORT (default: $PORT env)
      --profile <name>    profile to merge (default: none on a host, lifo in a box)
  -c, --config <path>     manifest path (default: ./orchd.json, then /orchd.json)
      --all               (resolve) the whole project, not one workload
      --json              (resolve) emit {cwd, argv, env, install} instead of a line
      --port-base <n>     (up/--all) first port to assign (default: 8080)
      --settle <ms>       (up) pause before moving the shell to the next
                          workload's directory (default: 500)
      --no-install        skip the install step even if node_modules is missing
```

## Booting the whole project

`orchd up` starts every workload at once. On a host it supervises them in the
foreground, the way `docker compose up` does — interleaved output under a
per-workload prefix, and Ctrl-C stops the set:

```console
$ npx orchd up
orchd: api -> PORT=3000 npm run dev (cwd /work/demo/api)
orchd: web -> API_URL=http://localhost:3000 PORT=3001 npm run dev (cwd /work/demo/web)
api | api dev server on 3000
web | web dev server on 3001
^C
orchd: stopping…
```

If any one workload exits, the rest are brought down and `up` exits with that
workload's code — a half-booted project is not a useful state to be left in.

In a box the same command backgrounds instead, because there you want the prompt
back:

```console
$ orchd up
orchd: api -> PORT=3000 node index.js (cwd /home/user/app/api)
orchd: mobile -> EXPO_PUBLIC_API_URL=http://localhost:3000 browser-metro . --port 8081 (cwd /home/user/app)
orchd: 2 workload(s) started; `jobs` to list them
```

Each workload gets a port — its declared `"port"`, otherwise one counting up
from `--port-base`. Workloads then refer to each other by **name**, and the port
is filled in:

```jsonc
{
  "name": "mobile",
  "env": { "EXPO_PUBLIC_API_URL": "${url:api}" }   // -> http://localhost:3000
}
```

`${url:<name>}` and `${port:<name>}` are the cross-workload forms. On a host
those siblings are separate subdomains; in a box everything shares localhost, so
the manifest names them and `up` resolves the addresses.

Inside a box, workloads start as **background jobs** — a shell runs one
foreground command at a time and a dev server never exits, so foregrounding
would boot only the first one. `up` returns to the prompt with everything
running; `jobs` lists them. On a host there is no such constraint, so `up`
stays in the foreground and owns the children.

## Profiles

The command a workload runs depends on what is executing it. A host wants the
project's real command — `npm run dev`, or `expo start --web`; a Lifo box usually
wants `browser-metro`, which bundles via a hosted pre-bundler instead of reading
`node_modules`. One manifest, one override block:

```jsonc
{
  "workloads": [{
    "name": "mobile",
    "kind": "node",
    "dir": "mobile",
    "install": ["npm", "install"],
    "run": ["npx", "expo", "start", "--web", "--port", "$PORT"],
    "profiles": {
      "lifo": { "run": ["browser-metro", ".", "--port", "$PORT"] }
    }
  }]
}
```

The base `run` is what a host executes. `profiles.lifo` applies only when a
runner asks for it, which the in-box command does by default and the bin does
only with `--profile lifo`.

`run`, `install` and `dir` replace wholesale when a profile overrides them;
`env` merges key-wise, so a profile can add one variable without restating the
rest. `$PORT` and `${PORT}` are substituted in argv; a workload with
`"port_env": "PORT"` gets the port as an environment variable instead.

```console
$ orchd list
db      tinbase .
api     node    api
mobile  node    mobile  profiles: lifo

$ orchd resolve --workload mobile --port 8082
browser-metro . --port 8082

$ orchd resolve --workload mobile --port 8082 --json
{"workload":"mobile","cwd":"/mobile","argv":["browser-metro",".","--port","8082"],"env":{},"install":["npm","install"]}
```

## `resolve` vs `run` vs `up`

`resolve --json` is the machine interface, and it is the same on both runners —
a supervising host gets `{ cwd, argv, env, install }` and can run the workload
with its own streaming, logging and signals.

Inside a box, prefer **`resolve`** for anything long-running. There `run` executes through
`ctx.executeCapture`, which buffers stdout/stderr and takes no `AbortSignal`, so
a dev server started that way produces no output until it exits and is not torn
down when the command is aborted. `run` is a convenience for interactive and
one-shot use.

`orchd up` avoids that problem by backgrounding, but its jobs' output goes to
the shell rather than being collected.

A host that supervises the workload should call `resolve --json` (or
`resolve --all --json` for the whole project) and run the commands itself,
keeping its own streaming and abort handling:

```ts
const spec = JSON.parse(await sandbox.commands.run('orchd resolve -w mobile -p 8082 --json'));
const ac = new AbortController();
sandbox.shell.execute(spec.argv.join(' '), { cwd: spec.cwd, env: { ...sandbox.env, ...spec.env }, signal: ac.signal });
await sandbox.waitForPort(8082);
```

## Note on background jobs and the working directory (box only)

A backgrounded job resolves its paths when it **starts**, not when it is
launched. Two consequences, both handled here but worth knowing:

- Passing `executeCapture` a `{cwd}` does not survive backgrounding — the
  capture restores the previous directory first and the job fails with `ENOENT`.
  `up` emits `cd <dir> && <cmd> &` instead.
- A later `cd` can still move the shell out from under a job that has not
  started yet. `up` pauses `--settle` milliseconds (default 500) before changing
  directory for the next workload, and returns the shell to where it started.

If lifo captured a job's working directory at spawn time, both workarounds could
go away.

## Note on `browser-metro` arguments

`browser-metro` drops its first argument (`ctx.args.slice(1)`), unlike
`systemctl`/`bc`, which read `args[0]` as a real argument. So
`browser-metro --port 8082` silently loses the flag and binds the default 8081.
Pass the project directory first — `browser-metro . --port 8082` — as the
example profile above does.
