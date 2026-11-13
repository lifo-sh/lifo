// WebLLM, loaded on first use: one model at a time, on WebGPU, optionally in a web worker so
// token generation never blocks the page or the terminal. Weights download from Hugging Face
// on first use and stay in the browser's Cache Storage after that.

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatRequest {
  messages: ChatMessage[];
  temperature?: number;
  max_tokens?: number;
  response_format?: { type: 'json_object'; schema?: string };
}

/** The slice of WebLLM's engine the agent uses; a test or another backend can supply its own. */
export interface ChatEngine {
  chat: { completions: { create(req: ChatRequest): Promise<{ choices: Array<{ message?: { content?: string | null } }> }> } };
  interruptGenerate(): void;
}

export interface LoadProgress {
  progress: number;
  text: string;
}

/** Loads (and downloads, the first time) a model. Rejects with a readable message. */
export type EngineFactory = (model: string, onProgress: (p: LoadProgress) => void) => Promise<ChatEngine>;

/**
 * Qwen3.5 gave the cleanest schema-constrained replies in the browser-in-browser experiment
 * (Qwen3 sometimes corrupted words). The 2B fits in about 2.2 GB of GPU memory, which suits a
 * web page; `--model Qwen3.5-4B-q4f16_1-MLC` is steadier on multi-step browsing.
 */
export const DEFAULT_MODEL = 'Qwen3.5-2B-q4f16_1-MLC';

export const SUGGESTED_MODELS = [
  'Qwen3.5-2B-q4f16_1-MLC',
  'Qwen3.5-4B-q4f16_1-MLC',
  'Qwen3-1.7B-q4f16_1-MLC',
  'Llama-3.2-3B-Instruct-q4f16_1-MLC',
];

type WebLLM = typeof import('@mlc-ai/web-llm');
let webllm: Promise<WebLLM> | null = null;
const loadWebLLM = () => (webllm ??= import('@mlc-ai/web-llm'));

export async function modelInfo(id: string) {
  return (await loadWebLLM()).prebuiltAppConfig.model_list.find((m) => m.model_id === id);
}

export async function allModelIds() {
  return (await loadWebLLM()).prebuiltAppConfig.model_list.map((m) => m.model_id);
}

/** Why WebGPU can't run here, or null if it can. */
export async function webgpuProblem(): Promise<string | null> {
  const gpu = (globalThis.navigator as Navigator & { gpu?: { requestAdapter(): Promise<unknown> } } | undefined)?.gpu;
  if (!gpu) return 'this browser has no WebGPU (use a recent Chrome, Edge or Safari)';
  try {
    if (!(await gpu.requestAdapter())) return 'WebGPU is present but no GPU adapter is available';
  } catch (e) {
    return `WebGPU adapter request failed: ${(e as Error).message}`;
  }
  return null;
}

export interface WebLLMOptions {
  /**
   * Runs the model in this worker. The worker module only needs `import 'lifo-pkg-agent/worker'`;
   * create it next to your code so your bundler sees it:
   *   worker: () => new Worker(new URL('./llm-worker.ts', import.meta.url), { type: 'module' })
   * Without it the model runs on the page's main thread.
   */
  worker?: () => Worker;
}

/** The default engine: a WebLLM prebuilt model, one loaded at a time. */
export function webllmEngine(options: WebLLMOptions = {}): EngineFactory {
  let current: { id: string; engine: Promise<ChatEngine> } | null = null;
  let worker: Worker | null = null;
  return async (model, onProgress) => {
    const problem = await webgpuProblem();
    if (problem) throw new Error(problem);
    if (!(await modelInfo(model))) throw new Error(`unknown model "${model}" (see: agent models)`);
    if (current?.id === model) return current.engine;
    if (current) current.engine.then((e) => (e as unknown as { unload(): Promise<void> }).unload()).catch(() => undefined);
    const lib = await loadWebLLM();
    const chatOpts = { context_window_size: model.startsWith('Qwen3') ? 8192 : 4096 };
    const engineOpts = { initProgressCallback: onProgress };
    let engine: Promise<ChatEngine>;
    if (options.worker) {
      worker ??= options.worker();
      engine = lib.CreateWebWorkerMLCEngine(worker, model, engineOpts, chatOpts) as unknown as Promise<ChatEngine>;
    } else {
      engine = lib.CreateMLCEngine(model, engineOpts, chatOpts) as unknown as Promise<ChatEngine>;
    }
    const entry = { id: model, engine };
    current = entry;
    engine.catch(() => {
      if (current === entry) current = null;
    });
    return engine;
  };
}
