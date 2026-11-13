# Tunnels

A tunnel gives a port a public URL. Share a dev server with someone, test a webhook, open
your app on a phone.

```bash
lifo-sh tunnel 3000 --name demo
#   ● https://demo-tunnel.lifo.sh  ->  localhost:3000
```

Tunnels need a lifo.sh login (`lifo-sh login`). Stop one with Ctrl+C.

## From your machine or from a box

| You run | It shares |
|---|---|
| `lifo-sh tunnel <port>` on your machine | `localhost:<port>` on your machine |
| `lifo tunnel <port>` (or `tunnel <port>`) in a box started by `lifo-sh` | the box's port |
| `lifo tunnel <port>` in a box in a browser tab | the box's port, while the tab is open |

The last one is unusual: a server running inside a browser tab, reachable from anywhere. The
tab is the server; close it and the tunnel ends.

## Names

- `--name demo` asks for `demo-tunnel.lifo.sh`. Names are 3 to 32 characters: lowercase
  letters, digits and single dashes. A few are reserved (`www`, `api`, `app`, `admin`, ...).
- Without `--name` you get a random one.
- A name belongs to whoever holds it. If it's yours, starting a new tunnel with the same name
  replaces the old one (the old one stops). If it's someone else's, you get an error.
- Up to 5 tunnels per account at a time.

## What gets through

HTTP requests of any method, with their headers and bodies (binary-safe, up to 25 MB), and
WebSockets, piped byte for byte, so a dev server's hot reload works through a tunnel. Your
server sees `Host: localhost:<port>` (dev servers check it) and the public host in
`X-Forwarded-Host`. A request that gets no answer within 60 seconds returns 504.

## The dashboard

The **Tunnels** tab on the dashboard lists your open tunnels, with their URL, port and
uptime. **Stop** closes one; the CLI or box that opened it exits.

## Security

Anyone with the URL can reach the server behind a tunnel, for as long as it runs. Don't tunnel
a server that holds anything private and has no authentication of its own. Every tunnel is
tied to the account that opened it.
