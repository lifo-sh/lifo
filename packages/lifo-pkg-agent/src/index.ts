// lifo-pkg-agent: an AI agent and a text web browser for Lifo boxes.
//
//   agent "<task>"   a WebLLM model on WebGPU runs shell commands until it can answer
//   browser <verb>   open, read and click through web pages, as plain text
//
// `lifo install agent` registers both with their defaults. A host page wires them itself to
// choose the model, run it in a worker and point `browser` at its proxy endpoint:
//
//   import { createAgentCommand, createBrowserCommand, webllmEngine } from 'lifo-pkg-agent';
//   box.commands.register('browser', createBrowserCommand());   // GET /api/browse?url=…
//   box.commands.register('agent', createAgentCommand({
//     engine: webllmEngine({ worker: () => new Worker(new URL('./llm-worker.ts', import.meta.url), { type: 'module' }) }),
//   }));
//
// The server side of `browser` is `lifo-pkg-agent/proxy` (Node).
import { createAgentCommand } from './agent.js';

export { createAgentCommand, parseStep, stripAnsi, type AgentOptions, type Runner } from './agent.js';
export { createBrowserCommand, proxyFetcher, directFetcher, type BrowserOptions, type FetchPage } from './browser.js';
export { loadPage, pageText, links, type Page, type PageSource, type ParseHtml } from './page.js';
export {
  DEFAULT_MODEL,
  SUGGESTED_MODELS,
  webllmEngine,
  webgpuProblem,
  modelInfo,
  allModelIds,
  type ChatEngine,
  type ChatMessage,
  type ChatRequest,
  type EngineFactory,
  type LoadProgress,
  type WebLLMOptions,
} from './llm.js';
export {
  buildSystemPrompt,
  DEFAULT_INTRO,
  PROTOCOL,
  SHELL_TOOLS,
  BROWSER_TOOLS,
  SHELL_EXAMPLES,
  BROWSER_EXAMPLES,
  RULES,
  type PromptParts,
} from './prompt.js';

export default createAgentCommand();
