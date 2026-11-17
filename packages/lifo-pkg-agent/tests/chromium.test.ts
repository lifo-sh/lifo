import { describe, expect, it } from 'vitest';
import type { Command, CommandContext } from '@lifo-sh/core';
import { createChromiumBrowserCommand } from '../src/chromium/index.js';
import { ChromiumFrame } from '../src/chromium/frame.js';
import { ctx } from './helpers.js';

const textBrowser: Command = async (c) => {
  c.stdout.write(`text browser: ${c.args.join(' ')}\n`);
  return 0;
};

const PAGE = { url: 'https://example.com/', title: 'Example Domain', loading: false, ready: 'complete', scrollY: 0, viewport: 800, height: 800 };

/**
 * A CDP endpoint in-process: answers the commands ChromiumFrame sends, records them, and runs the
 * page helpers' calls against canned results (by name).
 */
function fakeCdp(log: { method: string; params: Record<string, unknown>; sessionId?: string }[], helpers: Record<string, unknown> = {}) {
  return class FakeWS {
    readyState = 0;
    protocol = '';
    binaryType = 'blob';
    private l: Record<string, ((ev: { data?: unknown }) => void)[]> = {};
    constructor(public url: string) {
      queueMicrotask(() => {
        this.readyState = 1;
        this.emit('open', {});
      });
    }
    addEventListener(type: string, fn: (ev: { data?: unknown }) => void) {
      (this.l[type] ||= []).push(fn);
    }
    private emit(type: string, ev: { data?: unknown }) {
      for (const f of this.l[type] || []) f(ev);
    }
    close() {
      this.emit('close', {});
    }
    send(text: string) {
      const m = JSON.parse(text);
      log.push({ method: m.method, params: m.params, sessionId: m.sessionId });
      let result: unknown = {};
      switch (m.method) {
        case 'Target.getTargets':
          result = { targetInfos: [] };
          break;
        case 'Target.createTarget':
          result = { targetId: 'T1' };
          break;
        case 'Target.attachToTarget':
          result = { sessionId: 'S1' };
          break;
        case 'Page.getLayoutMetrics':
          result = { cssLayoutViewport: { clientWidth: 1280, clientHeight: 800 }, cssContentSize: { height: 2400 } };
          break;
        case 'Page.captureScreenshot':
          result = { data: Buffer.from('\x89PNG fake').toString('base64') };
          break;
        case 'Page.getNavigationHistory':
          result = { currentIndex: 1, entries: [{ id: 10 }, { id: 11 }] };
          break;
        case 'Runtime.evaluate': {
          const expr = String(m.params.expression);
          const call = /__bu\.call\("(\w+)", (.*)\); \}\)\(\)$/.exec(expr);
          if (call) {
            const name = call[1];
            const v = name === 'info' ? PAGE : helpers[name] ?? true;
            result = { result: { value: JSON.stringify({ ok: true, v }) } };
          } else if (expr === 'throw') {
            result = { result: {}, exceptionDetails: { text: 'Uncaught', exception: { description: 'Error: boom\n at x' } } };
          } else {
            result = { result: { value: expr === '1+1' ? 2 : { a: 1 } } };
          }
          break;
        }
      }
      queueMicrotask(() => this.emit('message', { data: JSON.stringify({ id: m.id, result }) }));
    }
  };
}

function withEnv(c: CommandContext, env: Record<string, string>) {
  (c as { env: Record<string, string> }).env = env;
  return c;
}

describe('ChromiumFrame', () => {
  it('opens the box\'s first page (or a new one), then routes verbs to CDP and the page helpers', async () => {
    const log: { method: string; params: Record<string, unknown>; sessionId?: string }[] = [];
    const frame = new ChromiumFrame({ endpoint: 'ws://cdp.example/x', WebSocket: fakeCdp(log, { text: 'Hello world\n', state: { ...PAGE, lines: ['<a> More'] } }) as never });
    await frame.ready;
    expect(log.slice(0, 4).map((l) => l.method)).toEqual(['Target.getTargets', 'Target.createTarget', 'Target.attachToTarget', 'Page.enable']);

    await frame.call('goto', 'example.com');
    expect(log.at(-1)).toMatchObject({ method: 'Page.navigate', params: { url: 'https://example.com' }, sessionId: 'S1' });
    await frame.call('goto', 'lifo browser cdp');
    expect(String(log.at(-1)?.params.url)).toContain('duckduckgo.com/html/?q=lifo%20browser%20cdp');
    await frame.call('key', 'Enter');
    expect(log.slice(-2).map((l) => [l.method, l.params.type, l.params.key])).toEqual([
      ['Input.dispatchKeyEvent', 'keyDown', 'Enter'],
      ['Input.dispatchKeyEvent', 'keyUp', 'Enter'],
    ]);
    await frame.call('back');
    expect(log.at(-1)).toMatchObject({ method: 'Page.navigateToHistoryEntry', params: { entryId: 10 } });
    expect(await frame.call('eval', '1+1')).toBe('2');
    await expect(frame.call('eval', 'throw')).rejects.toThrow('Error: boom');
    expect(await frame.call('text')).toBe('Hello world\n');
    expect((await frame.info()).title).toBe('Example Domain');
    const shot = await frame.call<{ dataUrl: string; height: number }>('screenshot', true);
    expect(shot.dataUrl.startsWith('data:image/png;base64,')).toBe(true);
    expect(shot.height).toBe(2400);
    // The helpers are installed with the gBrowser shim the first time a page needs them.
    const install = log.find((l) => l.method === 'Runtime.evaluate' && String(l.params.expression).includes('gBrowser'));
    expect(install).toBeTruthy();
  });

  it('reports a connection that fails', async () => {
    class Refused {
      private l: Record<string, (() => void)[]> = {};
      constructor() {
        queueMicrotask(() => (this.l.error || []).forEach((f) => f()));
      }
      addEventListener(t: string, f: () => void) {
        (this.l[t] ||= []).push(f);
      }
      send() {}
      close() {}
    }
    const frame = new ChromiumFrame({ endpoint: 'ws://nowhere/x', WebSocket: Refused as never });
    await expect(frame.ready).rejects.toThrow(/can't connect/);
    expect(frame.error).toMatch(/can't connect/);
  });
});

describe('browser on Chromium (createChromiumBrowserCommand)', () => {
  it('uses BROWSER_WS_ENDPOINT when set, and says so in info', async () => {
    const log: { method: string; params: Record<string, unknown> }[] = [];
    const prev = globalThis.WebSocket;
    globalThis.WebSocket = fakeCdp(log, { click: { target: '<a> More' } }) as never;
    try {
      const cmd = createChromiumBrowserCommand({ fallback: textBrowser });
      const vfs = {};
      const i = ctx(['info'], { vfs: vfs as never });
      expect(await cmd(withEnv(i.c, { BROWSER_WS_ENDPOINT: 'ws://cdp.example/x' }))).toBe(0);
      expect(i.out()).toContain('backend: Chromium over CDP (BROWSER_WS_ENDPOINT)');
      const o = ctx(['open', 'https://example.com'], { vfs: vfs as never });
      expect(await cmd(withEnv(o.c, { BROWSER_WS_ENDPOINT: 'ws://cdp.example/x' }))).toBe(0);
      expect(o.out()).toContain('Example Domain');
      expect(log.some((l) => l.method === 'Page.navigate')).toBe(true);
      // The same connection serves the next command for this box.
      const opens = log.filter((l) => l.method === 'Target.attachToTarget').length;
      const k = ctx(['click', 'More'], { vfs: vfs as never });
      await cmd(withEnv(k.c, { BROWSER_WS_ENDPOINT: 'ws://cdp.example/x' }));
      expect(log.filter((l) => l.method === 'Target.attachToTarget').length).toBe(opens);
    } finally {
      globalThis.WebSocket = prev;
    }
  });

  it('asks Lifo services for the box\'s browser outside a tab, and falls back when it can\'t', async () => {
    const log: { method: string; params: Record<string, unknown> }[] = [];
    const prev = globalThis.WebSocket;
    globalThis.WebSocket = fakeCdp(log) as never;
    try {
      const asked: string[] = [];
      const cmd = createChromiumBrowserCommand({
        fallback: textBrowser,
        services: async () => ({ browserSession: async (box: string) => (asked.push(box), { wsEndpoint: 'ws://svc.example/v1/browser/cdp/bt_x' }) }),
      });
      const i = ctx(['info'], { vfs: {} as never });
      await cmd(withEnv(i.c, { LIFO_BOX: 'My API' }));
      expect(asked).toEqual(['my-api']);
      expect(i.out()).toContain('Chromium on Lifo\'s Browser service (box "my-api")');

      const noLogin = createChromiumBrowserCommand({ fallback: textBrowser, services: async () => 'browser runs on Lifo Cloud here, which needs a login. Run: lifo login' });
      const n = ctx(['info'], { vfs: {} as never });
      await noLogin(withEnv(n.c, {}));
      expect(n.out()).toContain('backend: text browser (browser runs on Lifo Cloud here, which needs a login');
      const local = ctx(['open', 'x.com'], { vfs: {} as never });
      await cmd(withEnv(local.c, { LIFO_BROWSER: 'local' }));
      expect(local.out()).toBe('text browser: open x.com\n');
    } finally {
      globalThis.WebSocket = prev;
    }
  });
});
