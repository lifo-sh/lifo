// `browser` backed by a real Firefox (Gecko in WebAssembly) shown next to the terminal. Same verbs
// and output as the text browser (../browser.ts), so the agent's prompt is shared, plus key, eval,
// screenshot, wait and restart. Output is plain text: `browser text | grep -i price`.
//
// When Firefox can't run (the page isn't cross-origin isolated, no relay because nobody is logged
// in, or the boot failed) every verb goes to `fallback`, the text browser, and `browser info` says
// which one answered.
import type { Command, CommandContext } from '@lifo-sh/core';
import type { PageInfo } from './frame.js';

/**
 * What the command drives: FirefoxFrame (Gecko in WebAssembly, in the page) or ChromiumFrame (a
 * real Chromium on Lifo's Browser service, over CDP). Both run the same page helpers.
 */
export interface BrowserFrame {
  ready: Promise<void>;
  readonly isReady: boolean;
  error: string | null;
  call<T = unknown>(name: string, ...args: unknown[]): Promise<T>;
  info(): Promise<PageInfo>;
  waitForLoad(before: PageInfo | null, timeoutMs?: number, settleMs?: number): Promise<PageInfo>;
  restart(): Promise<void>;
}

export interface FirefoxBrowserOptions {
  /** The text browser, used whenever the real browser isn't available. */
  fallback?: Command;
  /** The backend's name in messages ("Firefox", "Chromium"). */
  name?: string;
  /** What `browser info` says the backend is. */
  describe?: string;
  /** The first line of `browser help`. */
  intro?: string;
}

const c = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
};

const help = (intro: string, name: string) => `${intro} Targets are an index from ${c.cyan('state')}, a CSS selector, or visible text.

  ${c.cyan('open')} <url>                 go to a URL (or search words)
  ${c.cyan('state')} [--all] [--no-highlight]
                              list clickable elements as [n] and number them on the page
  ${c.cyan('click')} <target>             click an element
  ${c.cyan('type')} <target> <text> [--enter] [--append]
                              type into a field (replaces its value unless --append)
  ${c.cyan('select')} <target> <option>   pick an option in a <select>
  ${c.cyan('key')} <name>                 press a key: Enter, Tab, Escape, ArrowDown, …
  ${c.cyan('scroll')} [down|up|top|bottom] [px]
  ${c.cyan('back')} | ${c.cyan('forward')} | ${c.cyan('reload')}
  ${c.cyan('text')}                       the page's visible text (pipe it: browser text | grep …)
  ${c.cyan('links')}                      every link as  text<TAB>url
  ${c.cyan('eval')} <js>                  run JavaScript in the page and print the result
  ${c.cyan('screenshot')} [file] [--full] save a PNG into the lifo filesystem
  ${c.cyan('wait')} <selector|ms> [--timeout s]
  ${c.cyan('info')} | ${c.cyan('url')} | ${c.cyan('title')}
  ${c.cyan('restart')}                    restart ${name} (fresh engine and network connection)

Examples:
  browser open news.ycombinator.com && browser state
  browser click new
  browser type q "webassembly" --enter
  browser text | grep -i rust | head
`;

function flags(args: string[]) {
  const set = new Set<string>();
  const values: Record<string, string> = {};
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--timeout') values.timeout = args[++i] ?? '';
    else if (a.startsWith('--')) set.add(a.slice(2));
    else rest.push(a);
  }
  return { has: (f: string) => set.has(f), values, rest };
}

function resolvePath(ctx: CommandContext, p: string) {
  if (p.startsWith('~/') || p === '~') p = (ctx.env.HOME || '/home/user') + p.slice(1);
  return p.startsWith('/') ? p : `${ctx.cwd.replace(/\/$/, '')}/${p}`;
}

function pageLine(p: PageInfo) {
  return `${c.green('✓')} ${c.bold(p.title || '(untitled)')}  ${c.dim(p.url)}`;
}

export function createFirefoxBrowserCommand(firefox: () => BrowserFrame | null, opts: FirefoxBrowserOptions = {}): Command {
  const name = opts.name ?? 'Firefox';
  const describe = opts.describe ?? 'Firefox (Gecko in WebAssembly), in the pane on the right';
  const HELP = help(opts.intro ?? `${c.bold('browser')} drives the Firefox next to this terminal.`, name);
  return async (ctx) => {
    const out = (s = '') => ctx.stdout.write(s + '\n');
    const [sub = 'help', ...args] = ctx.args;
    const f = flags(args);
    const ff = firefox();

    // The real browser isn't there or couldn't start: the text browser answers.
    const fallback = async (why: string) => {
      if (sub === 'info') out(`backend: text browser (${why})`);
      if (!opts.fallback) {
        ctx.stderr.write(`${c.red('browser:')} ${why}\n`);
        return 1;
      }
      return opts.fallback(ctx);
    };
    if (!ff) return fallback(`${name} is not available on this page`);
    if (ff.error && sub !== 'restart') return fallback(`${name}: ${ff.error}`);

    if (sub === 'help' || sub === '--help' || sub === '-h') {
      ctx.stdout.write(HELP);
      return 0;
    }

    try {
      if (!ff.isReady && sub !== 'restart') {
        ctx.stderr.write(c.dim(`waiting for ${name} to finish starting…\n`));
        try {
          await ff.ready;
        } catch (e) {
          return fallback(`${name}: ${(e as Error).message}`);
        }
      }

      // Runs an action that may navigate, then waits for the page to settle.
      const act = async <T>(fn: () => Promise<T>) => {
        const before = await ff.info();
        const res = await fn();
        const after = await ff.waitForLoad(before);
        return { res, before, after };
      };

      switch (sub) {
        case 'open':
        case 'goto': {
          const url = f.rest.join(' ');
          if (!url) throw new Error('usage: browser open <url>');
          const { after } = await act(() => ff.call('goto', url));
          out(pageLine(after));
          return 0;
        }

        case 'state': {
          const s = await ff.call<PageInfo & { lines: string[] }>('state', f.has('all'), !f.has('no-highlight'));
          out(pageLine(s));
          const pct = s.height > s.viewport ? Math.round((s.scrollY / (s.height - s.viewport)) * 100) : 0;
          out(c.dim(`viewport ${s.scrollY}–${s.scrollY + s.viewport} of ${s.height}px (${pct}%)${f.has('all') ? '' : ', visible elements only'}`));
          if (!s.lines.length) out(c.dim('(no interactive elements)'));
          s.lines.forEach((line, i) => out(`${c.yellow(`[${i + 1}]`)} ${line}`));
          return 0;
        }

        case 'click': {
          const target = f.rest.join(' ');
          if (!target) throw new Error('usage: browser click <target>');
          const { res, before, after } = await act(() => ff.call<{ target: string }>('click', target));
          out(`${c.green('clicked')} ${res.target}`);
          if (after.url !== before.url) out(pageLine(after));
          return 0;
        }

        case 'type':
        case 'fill': {
          const [target, ...words] = f.rest;
          if (!target || !words.length) throw new Error('usage: browser type <target> <text> [--enter]');
          const r = await ff.call<{ target: string; value: string }>('type', target, words.join(' '), f.has('append'));
          out(`${c.green('typed')} into ${r.target}`);
          if (f.has('enter') || f.has('submit')) {
            const { after } = await act(() => ff.call('key', 'Enter'));
            out(pageLine(after));
          }
          return 0;
        }

        case 'select': {
          const [target, ...opt] = f.rest;
          if (!target || !opt.length) throw new Error('usage: browser select <target> <option>');
          const r = await ff.call<{ target: string }>('select', target, opt.join(' '));
          out(`${c.green('selected')} ${opt.join(' ')} in ${r.target}`);
          return 0;
        }

        case 'key':
        case 'press': {
          const name = f.rest[0];
          if (!name) throw new Error('usage: browser key <name>');
          const { before, after } = await act(() => ff.call('key', name));
          out(`${c.green('pressed')} ${name}`);
          if (after.url !== before.url) out(pageLine(after));
          return 0;
        }

        case 'scroll': {
          const dir = f.rest[0] || 'down';
          const px = f.rest[1] ? Number(f.rest[1]) : undefined;
          const p = await ff.call<PageInfo>('scroll', dir, px);
          out(c.dim(`scrolled ${dir}: now at ${p.scrollY}px of ${p.height}px`));
          return 0;
        }

        case 'back':
        case 'forward':
        case 'reload': {
          const { after } = await act(() => ff.call(sub));
          out(pageLine(after));
          return 0;
        }

        case 'text':
        case 'extract': {
          const t = await ff.call<string>('text');
          ctx.stdout.write(t.endsWith('\n') ? t : t + '\n');
          return 0;
        }

        case 'links': {
          const links = await ff.call<[string, string][]>('links');
          for (const [text, href] of links) out(`${text || c.dim('(no text)')}\t${href}`);
          return 0;
        }

        case 'eval':
        case 'js': {
          const js = f.rest.join(' ');
          if (!js) throw new Error('usage: browser eval <js>');
          out(await ff.call<string>('eval', js));
          return 0;
        }

        case 'screenshot': {
          const shot = await ff.call<{ dataUrl: string; width: number; height: number }>('screenshot', f.has('full'));
          const file = resolvePath(ctx, f.rest[0] || `screenshot-${new Date().toISOString().replace(/[:.]/g, '-')}.png`);
          const bin = atob(shot.dataUrl.split(',')[1]);
          const bytes = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
          ctx.vfs.writeFile(file, bytes);
          out(`${c.green('saved')} ${file} ${c.dim(`(${shot.width}×${shot.height}, ${Math.round(bytes.length / 1024)} KB)`)}`);
          return 0;
        }

        case 'wait': {
          const what = f.rest.join(' ');
          if (!what) throw new Error('usage: browser wait <selector|ms>');
          if (/^\d+$/.test(what)) {
            await new Promise((r) => setTimeout(r, Number(what)));
            return 0;
          }
          const end = Date.now() + (Number(f.values.timeout) || 15) * 1000;
          while (Date.now() < end) {
            if (ctx.signal.aborted) return 130;
            if (await ff.call<boolean>('exists', what)) {
              out(`${c.green('found')} ${what}`);
              return 0;
            }
            await new Promise((r) => setTimeout(r, 250));
          }
          throw new Error(`timed out waiting for ${what}`);
        }

        case 'restart': {
          ctx.stderr.write(c.dim(`restarting ${name}…\n`));
          await ff.restart();
          out(`${c.green('✓')} ${name} restarted`);
          return 0;
        }

        case 'info': {
          const p = await ff.info();
          out(`backend: ${describe}`);
          out(JSON.stringify(p, null, 2));
          return 0;
        }
        case 'url':
          out((await ff.info()).url);
          return 0;
        case 'title':
          out((await ff.info()).title);
          return 0;

        default:
          throw new Error(`unknown subcommand "${sub}" (try: browser help)`);
      }
    } catch (e) {
      ctx.stderr.write(`${c.red('browser:')} ${(e as Error).message}\n`);
      return 1;
    }
  };
}
