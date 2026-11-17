# Accounts and login

Lifo runs without an account. You need one for the things that go through lifo.sh: public
tunnels today, and cloud actions as they arrive. Sign up at [lifo.sh](https://lifo.sh/register).

## Logging in from the CLI

```bash
lifo-sh login
```

The CLI opens lifo.sh in your browser. Approve the login there, and the browser hands it back
to the CLI. No key to copy. On a machine without a browser (over SSH), open the printed link
anywhere, approve, and paste the code the page shows into the terminal.

```bash
lifo-sh whoami     # you@example.com (https://lifo.sh)
lifo-sh logout     # forgets the login and revokes its key on lifo.sh
```

How it works: the CLI makes a one-time PKCE pair and the page you approve mints a short-lived
code tied to it. Only the CLI that started the login can turn that code into an API key, so a
code seen on screen or in a URL is useless to anyone else. The key is an ordinary `lifo_` API
key, listed on the dashboard as "CLI · <your machine>".

## Logging in from inside a box

```bash
lifo login
```

A box can't receive the browser's redirect, so inside a box login always uses the
paste-a-code flow: open the link, approve, paste the code. In a browser tab, the link opens in
a new tab for you. The key is stored in the box, at `~/.lifo/auth.json`.

A box started by `lifo-sh` uses the CLI's login automatically: there's nothing to do inside it.

## Terminals on lifo.sh

The terminals on lifo.sh's own pages (the examples on the home page, the docs, the agent page
and the playground) use your lifo.sh login when you're logged in. `lifo whoami` says so, and
`lifo tunnel` and `lifo cloud` work straight away:

```bash
lifo whoami
# you@example.com (https://lifo.sh, from this page's login)
```

The terminal gets a token that lasts an hour, the first time one of those commands needs it.
It isn't an API key: it isn't stored or listed on the dashboard, `lifo logout` doesn't end it
(log out on the website, or let it expire), and a tunnel it opened keeps running until you stop
it. The token isn't put in the box's environment or files, so `env` and a pushed snapshot don't
show it. Logged out, the terminals behave as before: `lifo login` uses the paste-a-code flow.

Boxes that other sites embed never get your login. To give boxes on your own site a login, see
`auth` in [Sandbox.create](../reference/sandbox.md#sandboxcreateoptions).

## Which site

Logins are kept per site in `~/.lifo/auth.json`, so you can be logged in to lifo.sh and to a
local copy at the same time.

- `--base-url <url>` (or `--local` for `http://localhost:3000`) picks the site for one command.
- A terminal on a site's own page uses that site.
- `LIFO_BASE_URL` sets it for a shell.
- Otherwise commands use the site you last logged in to, then lifo.sh.

## API keys

Keys authenticate the CLI and your own scripts. The dashboard's **API keys** tab lists them,
shows when each was last used, creates new ones and revokes them. Each `lifo login` creates
its own key; `lifo logout` revokes the key it was using.

```bash
curl -H "authorization: Bearer lifo_..." https://lifo.sh/api/me
```

Treat a key like a password: it can open tunnels as you.
