# lifo-pkg-agent

An AI agent and a text web browser for [Lifo](https://lifo.sh) boxes.

- `agent "<task>"`: a WebLLM model on WebGPU, in the visitor's browser, runs shell commands
  until it can answer. No API key, no model server.
- `browser <verb>`: `open`, `text`, `state`, `click`, `type`, `links`, … as plain text, so it
  pipes into `grep` and `head`.
- `lifo-pkg-agent/proxy`: the server endpoint `browser` reads pages through
  (`GET /api/browse?url=…`), limited to public addresses, GET, 2 MB and 10 s.

```js
import { createAgentCommand, createBrowserCommand, webllmEngine } from 'lifo-pkg-agent';

box.commands.register('browser', createBrowserCommand());
box.commands.register('agent', createAgentCommand({
  engine: webllmEngine({ worker: () => new Worker(new URL('./llm-worker.js', import.meta.url), { type: 'module' }) }),
}));
// llm-worker.js: import 'lifo-pkg-agent/worker';
```

Docs: [lifo.sh/docs/build/agents](https://lifo.sh/docs/build/agents). MIT.
