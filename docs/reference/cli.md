# The lifo-sh CLI

```bash
npx lifo-sh [command] [options]
npm install -g lifo-sh     # adds `lifo-sh`, and from 0.11 also `lifo`
```

Node.js 20+. `lifo-sh --help` prints this list; `lifo-sh --version` the version. Guide:
[In your terminal](../run/terminal.md).

## Boxes

| | |
|---|---|
| `lifo-sh` | an interactive shell in a new box; the box ends with the shell |
| `lifo-sh new` | a box that keeps running, attached now (Ctrl+D detaches) |
| `lifo-sh --detach` | a box that keeps running, in the background; prints its id |
| `lifo-sh list` | running boxes |
| `lifo-sh attach <id>` | a shell in a running box |
| `lifo-sh attach <host>:<port>` | the same, over TCP (a box started with `--port`) |
| `lifo-sh stop <id>` | stop a box |

Options for `lifo-sh`, `new` and `--detach`:

| | |
|---|---|
| `--mount <dir>`, `-m` | a folder on this machine at `/mnt/host` (default: a new temp folder) |
| `--expose <port>[:<hostPort>]` | publish a box port on `127.0.0.1` (hostPort defaults to port); repeatable; WebSockets included |
| `--port <tcp>` | with `--detach` or `new`: also accept attaches over TCP, on every interface, **without authentication** |

## Snapshots

| | |
|---|---|
| `lifo-sh snapshot save <id> [--output <file>]` | save a running box (default `~/.lifo/snapshots/<id>-<time>.tar.gz`) |
| `lifo-sh snapshot restore <file> [--mount <dir>]` | a new box from a snapshot, attached; mounts `--mount`, else the original folder if it exists, else a temp folder |
| `lifo-sh snapshot list` | saved snapshots |

## lifo.sh

| | |
|---|---|
| `lifo-sh login [--base-url <url> \| --local] [--no-browser]` | log in through the browser; `--no-browser` only prints the link and asks for the code |
| `lifo-sh whoami` | who's logged in, and to which site |
| `lifo-sh logout` | forget the login and revoke its key |
| `lifo-sh tunnel <port> [--name <name>]` | put `localhost:<port>` on a public URL; see [Tunnels](../cloud/tunnels.md) |
| `lifo-sh cloud push <name> [--port N] [--start cmd]` | run the current folder on Lifo Cloud (as `/home/user/app`, without `.git`); `lifo-sh cloud pull <name>` saves it as `.tar.gz`; `lifo-sh cloud shell <name>` opens a shell there, like ssh; `lifo-sh cloud stats <name>` and `lifo-sh cloud usage` show what it used; see [Cloud boxes](../cloud/boxes.md) (preview) |

## Inside a box it starts

`git`, `vi`, `nano` and `less` are available; `tunnel <port>` and `lifo tunnel <port>` share
the box's own port; the CLI's login is passed in (`LIFO_AUTH_TOKEN`, `LIFO_BASE_URL`).

## Files

| | |
|---|---|
| `~/.lifo/sessions/` | running boxes |
| `~/.lifo/snapshots/` | saved snapshots |
| `~/.lifo/auth.json` | logins, one per site |
