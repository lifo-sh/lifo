// lifo-pkg-agent/chromium: `browser` on a real Chromium, attached on first use.
//
//   import { createChromiumBrowserCommand } from 'lifo-pkg-agent/chromium';
//   import { createBrowserCommand } from 'lifo-pkg-agent';
//   box.commands.register('browser', createChromiumBrowserCommand({ fallback: createBrowserCommand() }));
//
// Where the Chromium comes from, in order:
//   1. BROWSER_WS_ENDPOINT: any CDP WebSocket (a cloud box gets one; or a Chromium you run).
//   2. Lifo's Browser service, with the box's login (lifo login, or the page's login in a tab),
//      when LIFO_BROWSER is "remote", or "auto" (the default) outside a browser tab.
//   3. Otherwise the fallback: the text browser (or Firefox in WebAssembly, where the page has it).
// `browser info` says which one answered. The browser is the box's: its tabs stay open between
// commands and close by themselves after a few idle minutes.
import type { Command, CommandContext } from '@lifo-sh/core';
import { createFirefoxBrowserCommand } from '../firefox/command.js';
import { ChromiumFrame } from './frame.js';

export { ChromiumFrame, type ChromiumFrameOptions } from './frame.js';

interface ServicesLike {
  browserSession(box: string): Promise<{ wsEndpoint: string }>;
}

export interface ChromiumBrowserOptions {
  /** Used when no Chromium is available (and in a tab unless LIFO_BROWSER=remote). */
  fallback?: Command;
  /**
   * Lifo services for this box, or why not. Defaults to @lifo-sh/core's connectServices (the
   * box's login and the account server's servicesUrl).
   */
  services?: (ctx: CommandContext) => Promise<ServicesLike | string>;
}

const inTab = () => typeof window !== 'undefined' && typeof document !== 'undefined';

async function defaultServices(ctx: CommandContext): Promise<ServicesLike | string> {
  const core = (await import('@lifo-sh/core')) as unknown as { connectServices?: (ctx: CommandContext, what: string) => Promise<ServicesLike | string> };
  if (!core.connectServices) return 'this Lifo is too old for the Browser service';
  return core.connectServices(ctx, 'browser');
}

/** The box's name for the Browser service: its cloud name, else "default". */
function boxName(ctx: CommandContext): string {
  const n = (ctx.env.LIFO_BOX || 'default').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
  return n || 'default';
}

export function createChromiumBrowserCommand(opts: ChromiumBrowserOptions = {}): Command {
  // One Chromium connection per box (per filesystem), kept between commands.
  const frames = new WeakMap<object, { key: string; frame: ChromiumFrame }>();
  const services = opts.services ?? defaultServices;

  return async (ctx) => {
    const mode = (ctx.env.LIFO_BROWSER || 'auto').toLowerCase();
    const endpoint = ctx.env.BROWSER_WS_ENDPOINT;
    const wantRemote = !!endpoint || mode === 'remote' || (mode === 'auto' && !inTab());
    if (mode === 'local' || !wantRemote) {
      if (opts.fallback) return opts.fallback(ctx);
      ctx.stderr.write('browser: no browser here (set LIFO_BROWSER=remote to use Lifo\'s Browser service)\n');
      return 1;
    }

    const key = endpoint ? `ep:${endpoint}` : `svc:${boxName(ctx)}`;
    let entry = frames.get(ctx.vfs);
    if (!entry || entry.key !== key || entry.frame.error) {
      entry?.frame.close();
      let why: string | null = null;
      const endpointFn = endpoint
        ? endpoint
        : async () => {
            const svc = await services(ctx);
            if (typeof svc === 'string') {
              why = svc;
              throw new Error(svc);
            }
            return (await svc.browserSession(boxName(ctx))).wsEndpoint;
          };
      const frame = new ChromiumFrame({ endpoint: endpointFn });
      entry = { key, frame };
      frames.set(ctx.vfs, entry);
      try {
        await frame.ready;
      } catch (e) {
        frames.delete(ctx.vfs);
        // No Browser service here (not logged in, or none on this account server): the stand-in answers.
        if (opts.fallback && (why || mode === 'auto')) {
          if (ctx.args[0] === 'info') ctx.stdout.write(`backend: text browser (${why ?? (e as Error).message})\n`);
          return opts.fallback(ctx);
        }
        ctx.stderr.write(`browser: ${(e as Error).message}\n`);
        return 1;
      }
    }
    const frame = entry.frame;
    const cmd = createFirefoxBrowserCommand(() => frame, {
      fallback: opts.fallback,
      name: 'Chromium',
      describe: endpoint ? 'Chromium over CDP (BROWSER_WS_ENDPOINT)' : `Chromium on Lifo's Browser service (box "${boxName(ctx)}")`,
      intro: '\x1b[1mbrowser\x1b[0m drives a real Chromium for this box (Lifo\'s Browser service); its tabs stay open between commands.',
    });
    return cmd(ctx);
  };
}
