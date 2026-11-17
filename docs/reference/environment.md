# Environment variables

## Inside a box

| Variable | Default | |
|---|---|---|
| `HOME` | `/home/user` | |
| `USER` | `user` | |
| `HOSTNAME` | `lifo` | shown in the prompt |
| `PATH` | `/usr/bin:/bin` | |
| `SHELL`, `TERM`, `EDITOR` | `/bin/sh`, `xterm-256color`, `nano` | |
| `NPM_REGISTRY` | `https://registry.npmjs.org` | where `npm` installs from |
| `LIFO_CDN` | `https://esm.sh` | where Lifo packages load ES modules from |
| `LIFO_CORS_PROXY` | `http://localhost:3005/_cors?url=` | browser only: a proxy prefix for hosts that don't send CORS headers |
| `LIFO_CORS_PROXY_HOSTS` | `api.expo.dev,exp.host,u.expo.dev` | which hosts go through that proxy |
| `LIFO_BASE_URL` | `https://lifo.sh` | the site `lifo login`, `whoami` and `tunnel` use |
| `LIFO_AUTH_TOKEN` | | a lifo.sh key to use instead of the box's own login (`lifo-sh` sets it) |
| `LIFO_TUNNEL_URL` | from the site | the tunnel server's WebSocket URL |

Set them for one box with `Sandbox.create({ env })`, for a shell with `export`, or for one
command with `box.commands.run(cmd, { env })`.

## For the lifo-sh CLI

| Variable | |
|---|---|
| `LIFO_BASE_URL` | the site to log in to and open tunnels on (overrides the last login) |
| `LIFO_TUNNEL_URL` | the tunnel server's WebSocket URL, instead of asking the site |
| `LIFO_NO_BROWSER` | don't open a browser for `login`; print the link |
