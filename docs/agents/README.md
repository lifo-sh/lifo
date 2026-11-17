# Lifo for coding agents

Coding agents (Claude Code, Cursor, Codex and others) can set Lifo up in a project for you.
Three things help them get it right.

## The Lifo skill

A skill is a short file an agent loads when a task matches it. Lifo's covers when to use
Lifo, the API for each host, and the mistakes that are easy to make (bundling it on the
server, the missing xterm CSS, the service worker for previews, isolation).

```bash
mkdir -p .claude/skills/lifo
curl -fsSL https://lifo.sh/skill.md -o .claude/skills/lifo/SKILL.md
```

That's the Claude Code location; other agents that read skills or rules files can use the
same file. The source is [`skills/lifo/SKILL.md`](../../skills/lifo/SKILL.md) in this repo.

## The docs as Markdown

Every page of these docs is also plain Markdown, which agents read better than HTML:

- `https://lifo.sh/llms.txt`: an index of the docs, with a link to each page's Markdown
- `https://lifo.sh/docs/run/browser.md`: any page, with `.md` added to its URL

## Prompts to copy

On lifo.sh, each docs page has a **Copy prompt for agents** button, and each example has a
**Copy prompt** button. They copy a prompt that tells your agent what to build, which
Markdown page to read first, what to install, and how to check that it works. Paste it into
your agent in the project where you want Lifo. The landing page has one for getting started
and one for each of its live examples.

## When an agent uses Lifo itself

Lifo is also a cheap place for an agent to run things: a box boots in under a millisecond in
Node.js, has a shell, `node` and `npm`, and can be thrown away after each task. Give the model
one `bash` tool backed by `box.commands.run()` (see [In Node.js](../run/node.md#your-own-commands)),
or run the model in the tab itself with [`lifo-pkg-agent`](../build/agents.md).
Remember that a box is not a security boundary: code it runs can reach the process or page
that created it.
