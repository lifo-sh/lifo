# The lifo command (inside a box)

Every box has a `lifo` command, in the browser, in Node.js and in `lifo-sh`.

## Packages

| | |
|---|---|
| `lifo install <name>` (`i`, `add`) | install `lifo-pkg-<name>` from npm (or `<name>` if that's not found) and add its commands |
| `lifo remove <name>` (`rm`, `uninstall`) | remove a package |
| `lifo list` (`ls`) | installed packages and dev links |
| `lifo search <term>` | search npm for `lifo-pkg-*` packages |
| `lifo init <name>` | scaffold a package in the box |
| `lifo link [path]` | use a local package's commands without publishing it |
| `lifo unlink <name>` | remove a dev link |

See [Packages](../build/packages.md).

## lifo.sh

| | |
|---|---|
| `lifo login [--base-url <url> \| --local]` | log in: open the link, approve, paste the code |
| `lifo whoami` | who's logged in, and to which site |
| `lifo logout` | forget the login and revoke its key |
| `lifo tunnel <port> [--name <name>]` | share a server in this box on a public URL |
| `lifo cloud push <name> [--port N] [--start cmd] [--sleep-after 10m]` | run this box on Lifo Cloud; also `ls`, `status`, `stats`, `config`, `usage`, `exec`, `shell`, `logs`, `save`, `pull`, `restart`, `rm` ([Cloud boxes](../cloud/boxes.md), preview) |
| `lifo services [allow\|deny <tool> [--always] \| usage]` | tools that run on Lifo's servers (`ffmpeg`, `ffprobe`): list them, and choose which may upload this box's files without asking ([Services](../cloud/services.md), preview) |

The login is stored in the box at `~/.lifo/auth.json`. A box started by `lifo-sh` uses the
CLI's login instead. See [Accounts](../cloud/accounts.md), [Tunnels](../cloud/tunnels.md) and [Cloud boxes](../cloud/boxes.md).
