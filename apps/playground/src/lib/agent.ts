// `agent` and `browser` from lifo-pkg-agent, for the playground's shells. Both load on first use;
// WebLLM itself loads only when `agent` first runs, in the worker below.
//
// `browser` drives the real Firefox (Gecko in WebAssembly) when an example shows one
// (setFirefox, the "Browser agent" example) and is a text browser otherwise. The text browser reads
// pages through /api/browse: the lifo.sh site's route in production and embedded dev, the
// vite-plugin-browse middleware when the playground runs on its own.
import type { Command } from '@lifo-sh/core';
import type { FirefoxFrame } from 'lifo-pkg-agent/firefox';

const load = () => import('lifo-pkg-agent');

let firefox: (() => FirefoxFrame | null) | null = null;

/** Point `browser` at a Firefox shown by the current example (null to go back to text). */
export function setFirefox(getter: (() => FirefoxFrame | null) | null): void {
  firefox = getter;
}

export function registerAgentCommands(registry: { register(name: string, command: Command): void }): void {
  let text: Command | null = null;
  let viaFirefox: Command | null = null;
  registry.register('browser', async (ctx) => {
    text ??= (await load()).createBrowserCommand();
    if (!firefox) return text(ctx);
    viaFirefox ??= (await import('lifo-pkg-agent/firefox')).createFirefoxBrowserCommand(() => firefox?.() ?? null, { fallback: text });
    return viaFirefox(ctx);
  });
  let agent: Command | null = null;
  registry.register('agent', async (ctx) => {
    if (!agent) {
      const { createAgentCommand, webllmEngine } = await load();
      agent = createAgentCommand({
        engine: webllmEngine({ worker: () => new Worker(new URL('./llm-worker.ts', import.meta.url), { type: 'module' }) }),
      });
    }
    return agent(ctx);
  });
}
