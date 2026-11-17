import { describe, expect, it } from 'vitest';
import { createAgentCommand, parseStep } from '../src/agent';
import type { ChatEngine, ChatRequest } from '../src/llm';
import { ctx } from './helpers';

function scripted(replies: string[]) {
  const requests: ChatRequest[] = [];
  let interrupted = 0;
  const engine: ChatEngine = {
    chat: {
      completions: {
        create: async (req) => {
          requests.push(JSON.parse(JSON.stringify(req)));
          return { choices: [{ message: { content: replies.shift() ?? '{"thought":"?","action":"answer","input":"out of script"}' } }] };
        },
      },
    },
    interruptGenerate: () => void interrupted++,
  };
  return { engine, requests, interrupted: () => interrupted };
}

describe('agent', () => {
  it('runs commands until the model answers; the answer goes to stdout, the trace to stderr', async () => {
    const s = scripted([
      '{"thought":"open it","action":"run","input":"browser open news.ycombinator.com"}',
      '<think>hmm</think>{"thought":"read","action":"run","input":"browser text | head -3"}',
      '{"thought":"done","action":"answer","input":"The top story is First story."}',
    ]);
    const ran: string[] = [];
    const agent = createAgentCommand({ engine: async () => s.engine });
    const t = ctx(['What', 'is', 'the', 'top', 'story?'], {
      executeCaptureResult: async (cmd) => {
        ran.push(cmd);
        return { stdout: cmd.startsWith('browser text') ? '1. First story\n312 points' : '✓ Hacker News', stderr: '', code: 0 };
      },
    });
    expect(await agent(t.c)).toBe(0);
    expect(ran).toEqual(['browser open news.ycombinator.com', 'browser text | head -3']);
    expect(t.out()).toBe('The top story is First story.\n');
    expect(t.err()).toContain('$ browser open news.ycombinator.com');
    // The model saw the command output, and the system prompt documents the browser.
    expect(s.requests[2].messages.at(-1)!.content).toContain('1. First story');
    expect(s.requests[0].messages[0].content).toContain('browser open <url>');
    expect(s.requests[0].response_format?.type).toBe('json_object');
  });

  it('skips a command repeated a third time, and refuses to run itself', async () => {
    const s = scripted([
      '{"thought":"a","action":"run","input":"ls"}',
      '{"thought":"b","action":"run","input":"ls"}',
      '{"thought":"c","action":"run","input":"ls"}',
      '{"thought":"d","action":"run","input":"agent \\"x\\""}',
      '{"thought":"e","action":"answer","input":"ok"}',
    ]);
    let runs = 0;
    const agent = createAgentCommand({ engine: async () => s.engine });
    const t = ctx(['task'], { executeCaptureResult: async () => (runs++, { stdout: 'a b', stderr: '', code: 0 }) });
    expect(await agent(t.c)).toBe(0);
    expect(runs).toBe(2);
    expect(t.err()).toContain('skipped a repeat');
    expect(s.requests[4].messages.at(-1)!.content).toContain('cannot run `agent`');
  });

  it('forces an answer when out of steps', async () => {
    const s = scripted(['{"thought":"a","action":"run","input":"pwd"}', '{"thought":"z","action":"answer","input":"partial"}']);
    const agent = createAgentCommand({ engine: async () => s.engine });
    const t = ctx(['--steps', '1', 'task'], { executeCaptureResult: async () => ({ stdout: '/', stderr: '', code: 0 }) });
    expect(await agent(t.c)).toBe(0);
    expect(t.out()).toBe('partial\n');
    expect(s.requests[1].response_format?.schema).toContain('"enum":["answer"]');
  });

  it('reports a model that cannot load', async () => {
    const agent = createAgentCommand({ engine: async () => Promise.reject(new Error('this browser has no WebGPU')) });
    const t = ctx(['task']);
    expect(await agent(t.c)).toBe(1);
    expect(t.err()).toContain('no WebGPU');
  });

  it('stops on Ctrl+C', async () => {
    const ac = new AbortController();
    const s = scripted([]);
    s.engine.chat.completions.create = async () => {
      ac.abort();
      throw new Error('interrupted');
    };
    const agent = createAgentCommand({ engine: async () => s.engine });
    const t = ctx(['task'], { signal: ac.signal });
    expect(await agent(t.c)).toBe(130);
    expect(s.interrupted()).toBe(1);
  });

  it('prints help, and takes a custom prompt', async () => {
    const t = ctx([]);
    await createAgentCommand({ exampleTasks: ['hello'] })(t.c);
    expect(t.out()).toContain('agent "hello"');
    const s = scripted(['{"thought":"x","action":"answer","input":"y"}']);
    await createAgentCommand({ engine: async () => s.engine, prompt: { intro: 'CUSTOM INTRO', tools: ['TOOLS'] } })(ctx(['t']).c);
    expect(s.requests[0].messages[0].content).toMatch(/^CUSTOM INTRO[\s\S]*TOOLS/);
  });

  it('parses replies with junk around the JSON', () => {
    expect(parseStep('sure! {"thought":"t","action":"answer","input":" x "} done')).toEqual({ thought: 't', action: 'answer', input: 'x' });
    expect(parseStep('nope')).toEqual({ thought: '(unparseable reply: nope)', action: 'run', input: '' });
  });
});
