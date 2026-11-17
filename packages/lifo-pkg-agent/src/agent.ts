// `agent "<task>"`: a small ReAct loop that runs entirely in the tab. A model (WebLLM on
// WebGPU by default) picks one shell command per step, usually `browser …` piped to grep or
// head, sees its output, and repeats until it can answer. Every reply is constrained to a JSON
// schema at the token level, which keeps small models on the rails.
//
// The step trace goes to stderr and only the answer to stdout, so `agent "…" > answer.txt` and
// `agent "…" | tee` behave like any other command. Ctrl+C stops generation.
//
// From the browser-in-browser experiment, which also drives Firefox (Gecko in WebAssembly) and
// an Android emulator with the same loop.

import type { Command, CommandContext } from '@lifo-sh/core';
import { DEFAULT_MODEL, SUGGESTED_MODELS, allModelIds, modelInfo, webllmEngine, type ChatEngine, type ChatMessage, type EngineFactory } from './llm.js';
import { buildSystemPrompt, type PromptParts } from './prompt.js';

export type Runner = (cmd: string, signal: AbortSignal) => Promise<{ stdout: string; stderr: string; exitCode: number }>;

export interface AgentOptions {
  /** Loads the model. Default: `webllmEngine()` (main thread); pass `webllmEngine({ worker })` for a worker. */
  engine?: EngineFactory;
  /** Runs a command when the shell doesn't give the command its own runner (ctx.executeCaptureResult). */
  run?: Runner;
  defaultModel?: string;
  /** Listed by `agent models`. */
  suggestedModels?: string[];
  /** Step limit; `--steps` overrides it. Default 8. */
  maxSteps?: number;
  /** Seconds one command may take. Default 60. */
  commandTimeout?: number;
  /** Replace parts of the system prompt (intro, tools, examples, rules)… */
  prompt?: PromptParts;
  /** …or all of it. */
  systemPrompt?: string;
  /** Example tasks shown by `agent help`. */
  exampleTasks?: string[];
}

const c = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  magenta: (s: string) => `\x1b[35m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
};
export const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');

const SCHEMA = JSON.stringify({
  type: 'object',
  properties: {
    thought: { type: 'string' },
    action: { type: 'string', enum: ['run', 'answer'] },
    input: { type: 'string' },
  },
  required: ['thought', 'action', 'input'],
});
const ANSWER_SCHEMA = JSON.stringify({
  type: 'object',
  properties: { thought: { type: 'string' }, action: { type: 'string', enum: ['answer'] }, input: { type: 'string' } },
  required: ['thought', 'action', 'input'],
});

interface Step {
  thought: string;
  action: 'run' | 'answer';
  input: string;
}

/** Keeps the conversation inside the context window: older observations are cut short. */
function compact(messages: ChatMessage[]): ChatMessage[] {
  const lastObs = messages.length - 1;
  return messages.map((m, i) => {
    if (m.role !== 'user' || i < 2 || i >= lastObs - 2) return m;
    return m.content.length > 400 ? { ...m, content: m.content.slice(0, 400) + '\n…(older output trimmed)' } : m;
  });
}

function observation(cmd: string, r: { stdout: string; stderr: string; exitCode: number }, limit = 3000) {
  let out = stripAnsi(r.stdout + (r.stderr ? (r.stdout ? '\n' : '') + r.stderr : '')).trim();
  if (!out) out = '(no output)';
  if (out.length > limit) out = out.slice(0, limit) + `\n…(${out.length - limit} more characters; narrow it with grep or head)`;
  return `$ ${cmd}\n(exit ${r.exitCode})\n${out}`;
}

/** Parses a reply, tolerating a <think> block or stray text around the JSON object. */
export function parseStep(text: string): Step {
  try {
    const body = text.replace(/<think>[\s\S]*?<\/think>/g, '');
    const step = JSON.parse(body.slice(body.indexOf('{'), body.lastIndexOf('}') + 1)) as Partial<Step>;
    return { thought: String(step.thought ?? ''), action: step.action === 'answer' ? 'answer' : 'run', input: String(step.input ?? '').trim() };
  } catch {
    return { thought: `(unparseable reply: ${text.replace(/\s+/g, ' ').slice(0, 120) || 'empty'})`, action: 'run', input: '' };
  }
}

export function createAgentCommand(options: AgentOptions = {}): Command {
  const engineFactory = options.engine ?? webllmEngine();
  const defaultModel = options.defaultModel ?? DEFAULT_MODEL;
  const suggested = options.suggestedModels ?? SUGGESTED_MODELS;
  const system = options.systemPrompt ?? buildSystemPrompt(options.prompt);
  const examples = options.exampleTasks ?? ['What is the top story on Hacker News right now?', 'What is this machine?'];

  const help = `${c.bold('agent')} runs a task with an AI model that lives in this tab (WebLLM on WebGPU). It works with shell commands and the ${c.cyan('browser')} command.

  agent "<task>"                     run a task, print the answer
  agent --model <id> "<task>"        use another model (default ${defaultModel})
  agent --steps <n> "<task>"         step limit (default ${options.maxSteps ?? 8})
  agent models                       list suggested models

Examples:
${examples.map((e) => `  agent "${e}"`).join('\n')}

The first run downloads the model (about 1 to 3 GB); after that it loads from the browser cache.
`;

  return async (ctx: CommandContext) => {
    const err = (s = '') => ctx.stderr.write(s + '\n');
    let model = defaultModel;
    let maxSteps = options.maxSteps ?? 8;
    const words: string[] = [];
    const args = [...ctx.args];
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--model' || args[i] === '-m') model = args[++i] ?? model;
      else if (args[i] === '--steps') maxSteps = Math.max(1, Number(args[++i]) || maxSteps);
      else words.push(args[i]);
    }
    const task = words.join(' ').trim();

    if (!task || task === 'help' || task === '--help' || task === '-h') {
      ctx.stdout.write(help);
      return 0;
    }
    if (task === 'models') {
      for (const id of suggested) {
        const m = await modelInfo(id).catch(() => undefined);
        const gb = m?.vram_required_MB ? c.dim(`~${Math.round(m.vram_required_MB / 100) / 10} GB VRAM`) : '';
        ctx.stdout.write(`${id === defaultModel ? c.green('*') : ' '} ${id}  ${gb}\n`);
      }
      const total = await allModelIds().then((ids) => ids.length, () => 0);
      if (total) ctx.stdout.write(c.dim(`\n${total} models available in total; any WebLLM prebuilt id works with --model.\n`));
      return 0;
    }

    // ---- load the model -------------------------------------------------------------------------
    err(c.dim(`loading ${model} (cached after the first download)…`));
    let lastLine = '';
    let engine: ChatEngine;
    try {
      engine = await engineFactory(model, (r) => {
        const line = `  ${Math.round(r.progress * 100)}%  ${r.text.replace(/\s+/g, ' ').slice(0, 90)}`;
        if (line !== lastLine) ctx.stderr.write(`\r\x1b[2K${c.dim(line)}`);
        lastLine = line;
      });
    } catch (e) {
      err(`\r\x1b[2K${c.red('agent:')} ${(e as Error).message}`);
      return 1;
    }
    ctx.stderr.write('\r\x1b[2K');
    const onAbort = () => engine.interruptGenerate();
    ctx.signal.addEventListener('abort', onAbort);

    // Note: no `enable_thinking: false` for Qwen3. With it, the chat template prepends an empty
    // <think></think> block to the reply; the JSON schema alone already rules out thinking text.
    const ask = async (messages: ChatMessage[], schema: string): Promise<Step> => {
      const reply = await engine.chat.completions.create({
        messages: compact(messages),
        temperature: 0.2,
        max_tokens: 512,
        response_format: { type: 'json_object', schema },
      });
      const text = reply.choices[0]?.message?.content ?? '';
      messages.push({ role: 'assistant', content: text });
      return parseStep(text);
    };

    // Sub-commands run in this command's own interpreter (executeCaptureResult). A nested
    // sandbox.commands.run() from inside a running command never returns, so it's a fallback.
    const exec = (cmd: string) => {
      const job = ctx.executeCaptureResult
        ? ctx.executeCaptureResult(cmd).then((r) => ({ stdout: r.stdout, stderr: r.stderr, exitCode: r.code }))
        : options.run
          ? options.run(cmd, ctx.signal)
          : Promise.reject(new Error('this shell cannot run sub-commands for the agent'));
      const secs = options.commandTimeout ?? 60;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`command timed out after ${secs}s`)), secs * 1000);
      });
      return Promise.race([job, timeout]).finally(() => clearTimeout(timer));
    };

    // ---- the loop -------------------------------------------------------------------------------
    err(`${c.magenta('agent')} ${c.bold(task)}`);
    const messages: ChatMessage[] = [
      { role: 'system', content: system },
      { role: 'user', content: `Task: ${task}` },
    ];
    const seen = new Map<string, number>();
    const started = performance.now();

    const finish = (answer: string) => {
      const secs = ((performance.now() - started) / 1000).toFixed(1);
      err(c.dim(`done in ${secs}s with ${model}`));
      err(c.green(c.bold('answer:')));
      ctx.stdout.write(`${answer || '(empty)'}\n`);
      return 0;
    };

    try {
      for (let step = 1; step <= maxSteps; step++) {
        if (ctx.signal.aborted) return 130;
        const s = await ask(messages, SCHEMA);
        err(`${c.dim(`[${step}]`)} ${c.dim(s.thought)}`);
        if (s.action === 'answer') return finish(s.input);

        let obs: string;
        if (!s.input) {
          obs = 'Your reply had no command. Reply with action "run" and one shell command in "input".';
        } else if (/^\s*agent\b/.test(s.input)) {
          obs = 'You cannot run `agent` from inside the agent. Use other commands.';
        } else if ((seen.get(s.input) ?? 0) >= 2) {
          // Small models loop on one command; don't run it a third time.
          err(`    ${c.dim(`(skipped a repeat: ${s.input})`)}`);
          obs = `You already ran \`${s.input}\` twice and it will not show anything new. Run a different command, or answer now.`;
        } else {
          err(`    ${c.cyan('$')} ${s.input}`);
          const r = await exec(s.input).catch((e: Error) => ({ stdout: '', stderr: e.message, exitCode: 1 }));
          const shown = stripAnsi(r.stdout + r.stderr).trim().split('\n');
          for (const line of shown.slice(0, 4)) err(`    ${c.dim(line.slice(0, 110))}`);
          if (shown.length > 4) err(`    ${c.dim(`… ${shown.length - 4} more lines`)}`);
          obs = observation(s.input, r);
          if (/\|\s*grep\b/.test(s.input) && !stripAnsi(r.stdout).trim()) {
            obs += '\n\ngrep matched nothing. Look at the output without grep, piped through head.';
          }
          const n = (seen.get(s.input) ?? 0) + 1;
          seen.set(s.input, n);
          if (n >= 2) obs += '\n\nNote: you already ran this exact command. Try a different command, or answer if you can.';
        }
        messages.push({ role: 'user', content: `${obs}\n\n(step ${step} of ${maxSteps}) If this output answers the task, reply with action "answer" now.` });
      }

      // Out of steps: make it answer with what it has.
      messages.push({ role: 'user', content: 'You are out of steps. Answer now with what you found, and say what is missing.' });
      return finish((await ask(messages, ANSWER_SCHEMA)).input);
    } catch (e) {
      if (ctx.signal.aborted) {
        err(c.dim(`stopped (${(e as Error).message})`));
        return 130;
      }
      err(`${c.red('agent:')} ${(e as Error).message}`);
      return 1;
    } finally {
      ctx.signal.removeEventListener('abort', onAbort);
    }
  };
}
