import { describe, expect, it } from 'vitest';
import type { Command } from '@lifo-sh/core';
import { createFirefoxBrowserCommand } from '../src/firefox/command.js';
import type { FirefoxFrame } from '../src/firefox/frame.js';
import { ctx } from './helpers.js';

const textBrowser: Command = async (c) => {
  c.stdout.write(`text browser: ${c.args.join(' ')}\n`);
  return 0;
};

/** Just enough of a FirefoxFrame for the command's routing. */
function fakeFirefox(over: Partial<FirefoxFrame> = {}): FirefoxFrame {
  const info = { url: 'https://example.com/', title: 'Example Domain', loading: false, ready: 'complete', scrollY: 0, viewport: 700, height: 700 };
  return {
    isReady: true,
    error: null,
    ready: Promise.resolve(),
    info: async () => info,
    call: async (name: string) => (name === 'text' ? 'Example Domain\n' : info),
    waitForLoad: async () => info,
    restart: async () => {},
    ...over,
  } as unknown as FirefoxFrame;
}

describe('browser with a Firefox backend', () => {
  it('uses the text browser when there is no Firefox, and says so in info', async () => {
    const cmd = createFirefoxBrowserCommand(() => null, { fallback: textBrowser });
    const t = ctx(['open', 'example.com']);
    expect(await cmd(t.c)).toBe(0);
    expect(t.out()).toBe('text browser: open example.com\n');
    const i = ctx(['info']);
    await cmd(i.c);
    expect(i.out()).toContain('backend: text browser (Firefox is not available on this page)');
  });

  it('falls back when Firefox failed to boot (e.g. no login for the relay)', async () => {
    const cmd = createFirefoxBrowserCommand(() => fakeFirefox({ error: 'log in to lifo.sh to browse with Firefox', isReady: false }), { fallback: textBrowser });
    const i = ctx(['info']);
    await cmd(i.c);
    expect(i.out()).toContain('backend: text browser (Firefox: log in to lifo.sh to browse with Firefox)');
    expect(i.out()).toContain('text browser: info');
  });

  it('falls back when the boot fails while a command waits for it', async () => {
    const ready = Promise.reject(new Error('no network relay'));
    ready.catch(() => {});
    const cmd = createFirefoxBrowserCommand(() => fakeFirefox({ isReady: false, ready }), { fallback: textBrowser });
    const t = ctx(['title']);
    await cmd(t.c);
    expect(t.out()).toBe('text browser: title\n');
  });

  it('drives Firefox when it is up', async () => {
    const cmd = createFirefoxBrowserCommand(() => fakeFirefox(), { fallback: textBrowser });
    const o = ctx(['open', 'https://example.com']);
    expect(await cmd(o.c)).toBe(0);
    expect(o.out()).toContain('Example Domain  https://example.com/');
    const i = ctx(['info']);
    await cmd(i.c);
    expect(i.out()).toContain('backend: Firefox');
    const t = ctx(['text']);
    await cmd(t.c);
    expect(t.out()).toBe('Example Domain\n');
  });

  it('errors clearly without Firefox or a fallback', async () => {
    const cmd = createFirefoxBrowserCommand(() => null);
    const t = ctx(['open', 'x']);
    expect(await cmd(t.c)).toBe(1);
    expect(t.err()).toContain('Firefox is not available');
  });
});
