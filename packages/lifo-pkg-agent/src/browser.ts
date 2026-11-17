// `browser`: a text web browser for a Lifo box, with the verbs of browser-use's CLI. Output is
// plain text, so it composes with the shell: `browser text | grep -i price | head`.
//
// Pages are fetched through a small server endpoint (a box in a tab can't read other sites
// directly, because of CORS) and parsed with the tab's DOMParser. No page JavaScript runs.
// The browser-in-browser experiment drives a real Firefox (Gecko in WebAssembly) with the same
// verbs; that needs a raw TCP relay, which must not be public. See docs/build/agents.md.

import type { Command, CommandContext } from '@lifo-sh/core';
import {
  clean,
  describe,
  fieldNames,
  formOf,
  formUrl,
  inputType,
  isTextField,
  label,
  links,
  loadPage,
  pageText,
  resolveHref,
  type Page,
  type PageSource,
  type ParseHtml,
} from './page.js';

export type FetchPage = (url: string, signal: AbortSignal) => Promise<PageSource>;

export interface BrowserOptions {
  /**
   * Loads a page. Default: in a web page, GET `/api/browse?url=…` on the page's own server
   * (`proxyFetcher()`); where there's no `document` (Node), a direct `fetch`.
   */
  fetchPage?: FetchPage;
  /** Parses HTML. Default: the global DOMParser. */
  parseHtml?: ParseHtml;
  /** Elements per `state` screen (`scroll` moves by this much). Default 40. */
  pageSize?: number;
}

/** Fetches through a browse endpoint (see `lifo-pkg-agent/proxy`): GET <endpoint>?url=<url>. */
export function proxyFetcher(endpoint = '/api/browse'): FetchPage {
  return async (url, signal) => {
    const res = await fetch(`${endpoint}${endpoint.includes('?') ? '&' : '?'}url=${encodeURIComponent(url)}`, { signal });
    const data = (await res.json().catch(() => null)) as (PageSource & { error?: string }) | null;
    if (!res.ok || !data || data.error) throw new Error(data?.error ?? `the browse endpoint answered ${res.status}`);
    return data;
  };
}

/** Fetches directly. Fine in Node; in a web page only CORS-enabled sites answer. */
export const directFetcher: FetchPage = async (url, signal) => {
  const res = await fetch(url, { signal, redirect: 'follow' });
  return { url: res.url || url, status: res.status, contentType: res.headers.get('content-type') ?? '', body: await res.text() };
};

const c = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
};

const HELP = `${c.bold('browser')} is a text web browser. Pages load through this site's server; no page JavaScript runs.
A target is an index from ${c.cyan('state')}, visible text, a field's name, or a CSS selector.

  ${c.cyan('open')} <url | search words>    load a page (words search DuckDuckGo)
  ${c.cyan('text')}                         the page's readable text (pipe it: browser text | grep …)
  ${c.cyan('state')} [--all]                interactive elements as [n], a screen at a time
  ${c.cyan('click')} <target>               follow a link, press a submit button, tick a box
  ${c.cyan('type')} <target> <text> [--enter] [--append]
                               fill a field; --enter submits its form
  ${c.cyan('select')} <target> <option>     pick an option in a <select>
  ${c.cyan('links')}                        every link as  text<TAB>url
  ${c.cyan('scroll')} [down|up|top|bottom]  move the state screen
  ${c.cyan('back')} | ${c.cyan('forward')} | ${c.cyan('reload')}
  ${c.cyan('url')} | ${c.cyan('title')} | ${c.cyan('info')}

Examples:
  browser open news.ycombinator.com && browser text | head -20
  browser open "webassembly threads" && browser links | head
  browser open en.wikipedia.org && browser type search "Lifo" --enter
`;

const NO_JS = new Set(['eval', 'screenshot', 'key', 'wait', 'restart']);

function toUrl(input: string): string {
  const s = input.trim();
  if (/^https?:\/\//i.test(s)) return s;
  // One word with a dot and no spaces is a host name; anything else is a search.
  if (!/\s/.test(s) && /^[^/]+\.[a-z]{2,}(:\d+)?(\/.*)?$/i.test(s)) return `https://${s}`;
  return `https://html.duckduckgo.com/html/?q=${encodeURIComponent(s).replace(/%20/g, '+')}`;
}

interface Session {
  page: Page | null;
  back: string[];
  forward: string[];
  /** First element shown by `state`. */
  offset: number;
}

export function createBrowserCommand(options: BrowserOptions = {}): Command {
  const pageSize = options.pageSize ?? 40;
  const session: Session = { page: null, back: [], forward: [], offset: 0 };

  const fetchPage: FetchPage =
    options.fetchPage ?? (typeof document === 'undefined' ? directFetcher : proxyFetcher());
  const parse = (): ParseHtml | null => {
    if (options.parseHtml) return options.parseHtml;
    if (typeof DOMParser === 'undefined') return null;
    return (html) => new DOMParser().parseFromString(html, 'text/html');
  };

  return async (ctx: CommandContext) => {
    const out = (s = '') => ctx.stdout.write(s + '\n');
    const [sub = 'help', ...rest] = ctx.args;
    const flags = new Set(rest.filter((a) => a.startsWith('--')).map((a) => a.slice(2)));
    const args = rest.filter((a) => !a.startsWith('--'));

    const pageLine = (p: Page) => {
      const bad = p.status >= 400;
      const mark = bad ? c.red(`✗ ${p.status}`) : c.green('✓');
      const kind = p.doc ? '' : c.dim(` (${p.contentType || 'text'})`);
      return `${mark} ${c.bold(p.title || '(untitled)')}  ${c.dim(p.url)}${kind}${p.truncated ? c.dim(' (cut at 2 MB)') : ''}`;
    };

    const load = async (url: string, how: 'push' | 'replace' | 'none' = 'push') => {
      const src = await fetchPage(url, ctx.signal);
      const page = loadPage(src, parse());
      if (how === 'push' && session.page) {
        session.back.push(session.page.url);
        session.forward = [];
      }
      session.page = page;
      session.offset = 0;
      out(pageLine(page));
      if (page.doc && !page.elements.length && page.doc.querySelector('script') && pageText(page.doc).length < 80) {
        out(c.dim('(almost nothing here without JavaScript; this page probably builds itself in the browser)'));
      }
      return page.status >= 400 ? 1 : 0;
    };

    const need = (): Page => {
      if (!session.page) throw new Error('no page open; run: browser open <url>');
      return session.page;
    };

    /** Finds an element by [n], CSS selector, field name or visible text. */
    const find = (target: string, pool?: (el: Element) => boolean): Element => {
      const page = need();
      if (!page.doc) throw new Error('this page has no elements (it is not HTML)');
      const els = page.elements;
      const n = /^\[?(\d+)\]?$/.exec(target);
      if (n) {
        const el = els[Number(n[1]) - 1];
        if (!el) throw new Error(`no element [${n[1]}]; this page has ${els.length} (browser state)`);
        return el;
      }
      if (/^[#.[]|^[a-z]+[#.[]/i.test(target)) {
        try {
          const el = page.doc.querySelector(target);
          if (el) return el;
        } catch {
          // not a selector after all; fall through to text matching
        }
      }
      const candidates = pool ? els.filter(pool) : els;
      const t = target.toLowerCase().trim();
      const exact = candidates.filter((el) => label(el).toLowerCase() === t || fieldNames(el).includes(t));
      if (exact.length === 1) return exact[0];
      // The same field twice (a header and a page search box, say): take the first.
      if (exact.length > 1 && exact.every((el) => el.localName === exact[0].localName && el.getAttribute('name') && el.getAttribute('name') === exact[0].getAttribute('name'))) {
        return exact[0];
      }
      const partial = exact.length ? exact : candidates.filter((el) => label(el).toLowerCase().includes(t) || fieldNames(el).some((f) => f.includes(t)));
      if (partial.length === 1) return partial[0];
      if (!partial.length) throw new Error(`nothing matches "${target}"; run browser state to see the elements`);
      const list = partial
        .slice(0, 8)
        .map((el) => `  [${els.indexOf(el) + 1}] ${describe(el)}`)
        .join('\n');
      throw new Error(`"${target}" matches ${partial.length} elements, not choosing one. Use its number:\n${list}`);
    };

    const submit = async (form: Element, submitter?: Element) => {
      const r = formUrl(need(), form, submitter);
      if ('error' in r) throw new Error(r.error);
      return load(r.url);
    };

    try {
      if (sub === 'help' || sub === '--help' || sub === '-h') {
        ctx.stdout.write(HELP);
        return 0;
      }
      if (NO_JS.has(sub)) {
        ctx.stderr.write(`browser: "${sub}" needs a real browser engine; this text browser runs no page JavaScript\n`);
        return 2;
      }

      switch (sub) {
        case 'open':
        case 'goto': {
          if (!args.length) throw new Error('usage: browser open <url | search words>');
          return await load(toUrl(args.join(' ')));
        }

        case 'text': {
          const page = need();
          const text = page.doc ? pageText(page.doc) : page.raw;
          ctx.stdout.write(text.endsWith('\n') || !text ? text : text + '\n');
          return 0;
        }

        case 'state': {
          const page = need();
          out(pageLine(page));
          const els = page.elements;
          if (!els.length) {
            out(c.dim('(no interactive elements)'));
            return 0;
          }
          const all = flags.has('all');
          const from = all ? 0 : Math.min(session.offset, Math.max(0, els.length - 1));
          const to = all ? els.length : Math.min(els.length, from + pageSize);
          if (!all) out(c.dim(`elements ${from + 1}–${to} of ${els.length}${to < els.length ? ' (browser scroll down for more)' : ''}`));
          for (let i = from; i < to; i++) out(`${c.yellow(`[${i + 1}]`)} ${describe(els[i])}`);
          return 0;
        }

        case 'scroll': {
          const page = need();
          const dir = args[0] ?? 'down';
          const last = Math.max(0, Math.floor((page.elements.length - 1) / pageSize) * pageSize);
          if (dir === 'top') session.offset = 0;
          else if (dir === 'bottom') session.offset = last;
          else if (dir === 'up') session.offset = Math.max(0, session.offset - pageSize);
          else session.offset = Math.min(last, session.offset + pageSize);
          const to = Math.min(page.elements.length, session.offset + pageSize);
          out(c.dim(`elements ${page.elements.length ? session.offset + 1 : 0}–${to} of ${page.elements.length}`));
          return 0;
        }

        case 'click': {
          const target = args.join(' ');
          if (!target) throw new Error('usage: browser click <n | text | selector>');
          const el = find(target);
          const page = need();
          const tag = el.localName;
          if (tag === 'a') {
            const href = el.getAttribute('href') ?? '';
            if (href.startsWith('javascript:')) throw new Error('that link runs JavaScript, which this browser does not run');
            if (href.startsWith('#')) {
              out(c.dim(`(a link within this page: ${href})`));
              return 0;
            }
            const url = resolveHref(page, href);
            if (!url) throw new Error(`can't follow ${href}`);
            out(`${c.green('clicked')} ${describe(el)}`);
            return await load(url);
          }
          if (tag === 'input' && (inputType(el) === 'checkbox' || inputType(el) === 'radio')) {
            if (inputType(el) === 'radio') {
              const name = el.getAttribute('name');
              const form = formOf(el);
              if (name) for (const r of Array.from((form ?? page.doc!).querySelectorAll(`input[type="radio"]`))) if (r.getAttribute('name') === name) r.removeAttribute('checked');
              el.setAttribute('checked', '');
            } else if (el.hasAttribute('checked')) el.removeAttribute('checked');
            else el.setAttribute('checked', '');
            out(`${c.green('clicked')} ${describe(el)}`);
            return 0;
          }
          const submits = (tag === 'button' && (el.getAttribute('type') ?? 'submit').toLowerCase() === 'submit') || (tag === 'input' && ['submit', 'image'].includes(inputType(el)));
          const form = formOf(el);
          if (submits && form) {
            out(`${c.green('clicked')} ${describe(el)}`);
            return await submit(form, el);
          }
          if (tag === 'summary') {
            out(c.dim('(expands a section; its text is already in browser text)'));
            return 0;
          }
          throw new Error(`${describe(el)} does something with JavaScript, which this browser does not run`);
        }

        case 'type':
        case 'fill': {
          const [target, ...words] = args;
          if (!target || !words.length) throw new Error('usage: browser type <field> <text> [--enter] [--append]');
          const el = find(target, isTextField);
          if (!isTextField(el)) throw new Error(`${describe(el)} is not a text field`);
          const text = words.join(' ');
          if (el.localName === 'textarea') el.textContent = flags.has('append') ? (el.textContent ?? '') + text : text;
          else el.setAttribute('value', flags.has('append') ? (el.getAttribute('value') ?? '') + text : text);
          out(`${c.green('typed')} into ${describe(el)}`);
          if (flags.has('enter')) {
            const form = formOf(el);
            if (!form) throw new Error('the field is not in a form, so there is nothing to submit');
            return await submit(form);
          }
          return 0;
        }

        case 'select': {
          const [target, ...words] = args;
          if (!target || !words.length) throw new Error('usage: browser select <field> <option>');
          const el = find(target, (e) => e.localName === 'select');
          if (el.localName !== 'select') throw new Error(`${describe(el)} is not a <select>`);
          const want = words.join(' ').toLowerCase();
          const options = Array.from(el.querySelectorAll('option'));
          const opt =
            options.find((o) => clean(o.textContent).toLowerCase() === want || (o.getAttribute('value') ?? '').toLowerCase() === want) ??
            options.find((o) => clean(o.textContent).toLowerCase().includes(want));
          if (!opt) throw new Error(`no option "${words.join(' ')}"; options: ${options.map((o) => clean(o.textContent, 30)).join(', ')}`);
          options.forEach((o) => o.removeAttribute('selected'));
          opt.setAttribute('selected', '');
          out(`${c.green('selected')} ${clean(opt.textContent)}`);
          return 0;
        }

        case 'links': {
          for (const [text, url] of links(need())) out(`${text}\t${url}`);
          return 0;
        }

        case 'back':
        case 'forward': {
          const page = need();
          const from = sub === 'back' ? session.back : session.forward;
          const to = sub === 'back' ? session.forward : session.back;
          const url = from.pop();
          if (!url) throw new Error(`nothing to go ${sub} to`);
          to.push(page.url);
          return await load(url, 'none');
        }

        case 'reload':
          return await load(need().url, 'none');

        case 'url':
          out(need().url);
          return 0;

        case 'title':
          out(need().title);
          return 0;

        case 'info': {
          const p = need();
          out(`url: ${p.url}\ntitle: ${p.title}\nstatus: ${p.status}\ntype: ${p.contentType}\nelements: ${p.elements.length}\nlinks: ${links(p).length}`);
          return 0;
        }

        default:
          ctx.stderr.write(`browser: unknown command "${sub}" (browser help)\n`);
          return 2;
      }
    } catch (e) {
      if (ctx.signal.aborted) return 130;
      ctx.stderr.write(`${c.red('browser:')} ${(e as Error).message}\n`);
      return 1;
    }
  };
}

/** `lifo install agent` registers this as `browser`. */
export default createBrowserCommand();
