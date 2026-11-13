# Lifo in your terminal

`lifo-sh` runs a Lifo box on your machine and gives you its shell. It's the quickest way to
try Lifo, and a way to work on a real folder from inside a box: the same shell, commands and
Node.js runtime that run in a browser tab.

```bash
npx lifo-sh
```

Or install it. From 0.11 that gives you two names for the same command, `lifo-sh` and
`lifo`:

```bash
npm install -g lifo-sh
lifo
```

Needs Node.js 20 or newer. `lifo-sh --help` lists everything.

## A shell

```bash
lifo-sh                          # a fresh temp folder at /mnt/host
lifo-sh --mount .                # this folder at /mnt/host
```

You start in `/mnt/host`. Files there are your real files: what you change in the box
changes on disk, and the rest of the box (`/home/user`, `/tmp`, installed packages) lives in
memory. Type `exit` or press Ctrl+D to leave; the box goes away with the shell.

```
user@lifo:/mnt/host$ ls
package.json  src
user@lifo:/mnt/host$ npm install && npm run dev
```

## Boxes that keep running

```bash
lifo-sh new --mount .            # start a box and open its shell
# Ctrl+D detaches; the box keeps running

lifo-sh list                     # running boxes
lifo-sh attach 3f9c2a            # back into one
lifo-sh stop 3f9c2a
```

`lifo-sh --detach --mount .` starts one in the background and prints its ID without opening
a shell. Several terminals can attach to the same box.

In a box you're attached to, Ctrl+D detaches you; `exit` disconnects everyone attached.
Either way the box keeps running until `lifo-sh stop`.

To attach from another machine, start the box with `--port`:

```bash
lifo-sh --detach --port 7777     # also listens on TCP 7777, on every interface
lifo-sh attach 192.168.1.20:7777
```

The TCP port has no authentication: anyone who can reach it gets a shell. Use it only on a
network you trust.

## Servers in the box

A server started in the box listens on the box's own network, not on your machine. To open
it in your browser, publish its port with `--expose`:

```bash
lifo-sh --mount . --expose 5173            # box port 5173 -> http://127.0.0.1:5173
lifo-sh --mount . --expose 3000:8080       # box port 3000 -> http://127.0.0.1:8080
```

`--expose` can be repeated, works with `new` and `--detach`, forwards WebSockets too (so a
dev server's hot reload works), and only binds to `127.0.0.1`.

To put a port on a public URL instead, use a tunnel: `tunnel 5173` inside the box, or
`lifo-sh tunnel 5173` on your machine for a port that's already on `localhost`. Tunnels need
a lifo.sh login (see below).

## Snapshots

```bash
lifo-sh snapshot save 3f9c2a                      # -> ~/.lifo/snapshots/3f9c2a-<time>.tar.gz
lifo-sh snapshot save 3f9c2a --output app.tar.gz
lifo-sh snapshot list
lifo-sh snapshot restore app.tar.gz --mount .     # a new box from the snapshot, attached
```

A snapshot has the box's files, working directory and environment. The same file loads in a
web page (`box.importSnapshot()`) and in Node. Files under `/mnt/host` are in the snapshot
too; on restore, the box mounts the folder you give with `--mount`, or the original folder if
it still exists, or a new temp folder.

## lifo.sh: login and tunnels

```bash
lifo-sh login                    # opens lifo.sh in your browser; approve, and you're in
lifo-sh whoami
lifo-sh tunnel 3000 --name demo  # https://demo-tunnel.lifo.sh -> localhost:3000
lifo-sh logout                   # also revokes the key on lifo.sh
```

`login` waits for the browser to hand the login back. On a machine without a browser (over
SSH), open the printed link anywhere, approve, and paste the code it shows. Logins are kept
per site in `~/.lifo/auth.json`, so `lifo-sh login --base-url http://localhost:3000` (or
`--local`) for a local copy of lifo.sh doesn't replace your lifo.sh login; the last site you
logged in to is the default for later commands.

A box started by `lifo-sh` uses the same login, so `tunnel 5173` inside it works without
logging in again.

## Inside the box

The box is the same everywhere, so this applies to a browser tab too. Try it here:

```bash live
cd ~ && mkdir -p demo && cd demo
git init && echo '# demo' > README.md && git add README.md && git commit -m first
printf 'b\na\nc\n' > list.txt && sort list.txt | head -2
for f in /etc/*; do echo "$f"; done | wc -l
echo 'require("http").createServer((q, s) => s.end("hello")).listen(8080)' > srv.js
node srv.js &
curl -s localhost:8080
```

- **Commands**: about 80 (`ls`, `grep`, `sed`, `awk`, `find`, `tar`, `curl`, ...) and a
  bash-like shell with its own builtins, pipes, redirects, loops, functions, job control and
  tab completion. `help` lists them.
- **Node.js**: `node`, `npm`, `npx`. JavaScript runs through a Node.js compatibility layer;
  packages with native addons don't load.
- **Editors and git**: `git`, `vi`, `nano` and `less` are there from the start (in `lifo-sh`
  and on lifo.sh); each loads the first time you run it.
- **The `lifo` command**: `lifo install <pkg>` adds more Lifo packages (`ffmpeg`, `man`,
  `fastfetch`, ...); `lifo login`, `lifo whoami` and `lifo tunnel <port>` work as above.

## Where it keeps things

| | |
|---|---|
| `~/.lifo/sessions/` | running boxes (a socket and a state file each) |
| `~/.lifo/snapshots/` | snapshots saved without `--output` |
| `~/.lifo/auth.json` | lifo.sh logins, one per site |

## Security

The box's programs run inside the `lifo-sh` process on your machine, with your user's
permissions, and the box isn't a security boundary. `--mount` decides which folder they see
through the box's filesystem, not what they could reach with your access if they tried. Run
code you'd run on your machine anyway.
