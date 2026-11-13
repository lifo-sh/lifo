import { describe, expect, it } from 'vitest';
import { createBrowserCommand, type FetchPage } from '../src/browser';
import { ctx, parseHtml } from './helpers';

const HN = `<html><head><title>Hacker News</title><script>alert(1)</script><style>p{}</style></head><body>
<table><tr><td><a href="news">Hacker News</a> <a href="newest">new</a> | <a href="front">past</a></td></tr>
<tr class="athing"><td>1.</td><td><a href="https://example.com/a">First story</a> <span>(example.com)</span></td></tr>
<tr><td></td><td>312 points by alice 3 hours ago | <a href="item?id=1">120 comments</a></td></tr>
<tr class="athing"><td>2.</td><td><a href="https://example.org/b">Second story</a></td></tr>
</table>
<div hidden>secret hidden text</div><p style="display: none">also hidden</p>
<form action="/search" method="get"><input type="text" name="q" placeholder="Search"><input type="hidden" name="src" value="hn">
<select name="sort"><option value="new">Newest</option><option value="top">Top</option></select>
<label><input type="checkbox" name="exact"> Exact</label><button type="submit">Go</button></form>
<form action="/login" method="post"><input name="user"><input type="submit" value="Log in"></form>
<a href="javascript:void(0)">js link</a><button type="button">Menu</button>
</body></html>`;

function site(pages: Record<string, { body: string; type?: string; status?: number }>) {
  const calls: string[] = [];
  const fetchPage: FetchPage = async (url) => {
    calls.push(url);
    const key = Object.keys(pages).find((k) => url === k || url.split('?')[0] === k);
    if (!key) return { url, status: 404, contentType: 'text/html', body: '<title>Not found</title>' };
    const p = pages[key];
    return { url, status: p.status ?? 200, contentType: p.type ?? 'text/html; charset=utf-8', body: p.body };
  };
  return { calls, browser: createBrowserCommand({ fetchPage, parseHtml }) };
}

const run = async (browser: ReturnType<typeof createBrowserCommand>, ...args: string[]) => {
  const t = ctx(args);
  const code = await browser(t.c);
  return { code, out: t.out(), err: t.err() };
};

describe('browser', () => {
  it('opens a page and prints its title and URL', async () => {
    const { browser, calls } = site({ 'https://news.ycombinator.com/': { body: HN } });
    const r = await run(browser, 'open', 'news.ycombinator.com/');
    expect(calls).toEqual(['https://news.ycombinator.com/']);
    expect(r.code).toBe(0);
    expect(r.out).toContain('✓ Hacker News  https://news.ycombinator.com/');
  });

  it('turns words into a DuckDuckGo search', async () => {
    const { browser, calls } = site({});
    await run(browser, 'open', 'webassembly threads');
    expect(calls[0]).toBe('https://html.duckduckgo.com/html/?q=webassembly+threads');
  });

  it('reads the text: blocks on lines, scripts and hidden parts left out', async () => {
    const { browser } = site({ 'https://news.ycombinator.com/': { body: HN } });
    await run(browser, 'open', 'https://news.ycombinator.com/');
    const { out } = await run(browser, 'text');
    const lines = out.split('\n');
    expect(lines[0]).toBe('Hacker News new | past');
    expect(lines[1]).toBe('1. First story (example.com)');
    expect(lines[2]).toBe('312 points by alice 3 hours ago | 120 comments');
    expect(out).not.toMatch(/alert|secret|also hidden|p\{\}/);
  });

  it('numbers interactive elements and follows a link by number or text', async () => {
    const { browser, calls } = site({ 'https://news.ycombinator.com/': { body: HN }, 'https://example.com/a': { body: '<title>A</title>' } });
    await run(browser, 'open', 'https://news.ycombinator.com/');
    const state = await run(browser, 'state');
    expect(state.out).toContain('[1] <a href="news"> Hacker News');
    expect(state.out).toContain('<input type="text" name="q" placeholder="Search">');
    expect(state.out).not.toContain('type="hidden"');
    const n = state.out.split('\n').find((l) => l.includes('First story'))!.match(/\[(\d+)\]/)![1];
    const r = await run(browser, 'click', n);
    expect(r.out).toContain('✓ A  https://example.com/a');
    await run(browser, 'back');
    await run(browser, 'click', 'first story');
    expect(calls.filter((u) => u === 'https://example.com/a')).toHaveLength(2);
  });

  it('refuses to guess between several matches', async () => {
    const { browser } = site({ 'https://news.ycombinator.com/': { body: HN } });
    await run(browser, 'open', 'https://news.ycombinator.com/');
    const r = await run(browser, 'click', 'story');
    expect(r.code).toBe(1);
    expect(r.err).toContain('matches 2 elements');
  });

  it('fills and submits a GET form with its other fields', async () => {
    const { browser, calls } = site({ 'https://news.ycombinator.com/': { body: HN } });
    await run(browser, 'open', 'https://news.ycombinator.com/');
    await run(browser, 'select', 'sort', 'Top');
    await run(browser, 'click', 'Exact');
    await run(browser, 'type', 'q', 'rust', 'wasm', '--enter');
    expect(calls.at(-1)).toBe('https://news.ycombinator.com/search?q=rust+wasm&src=hn&sort=top&exact=on');
  });

  it('a submit button submits its form', async () => {
    const { browser, calls } = site({ 'https://news.ycombinator.com/': { body: HN } });
    await run(browser, 'open', 'https://news.ycombinator.com/');
    await run(browser, 'type', 'Search', 'x');
    await run(browser, 'click', 'Go');
    expect(calls.at(-1)).toBe('https://news.ycombinator.com/search?q=x&src=hn&sort=new');
  });

  it('does not send POST forms or run JavaScript', async () => {
    const { browser } = site({ 'https://news.ycombinator.com/': { body: HN } });
    await run(browser, 'open', 'https://news.ycombinator.com/');
    expect((await run(browser, 'click', 'Log in')).err).toContain('POST');
    expect((await run(browser, 'click', 'js link')).err).toContain('JavaScript');
    expect((await run(browser, 'click', 'Menu')).err).toContain('JavaScript');
    expect((await run(browser, 'eval', '1+1')).code).toBe(2);
  });

  it('lists links as text<TAB>absolute url', async () => {
    const { browser } = site({ 'https://news.ycombinator.com/': { body: HN } });
    await run(browser, 'open', 'https://news.ycombinator.com/');
    const { out } = await run(browser, 'links');
    expect(out).toContain('new\thttps://news.ycombinator.com/newest');
    expect(out).toContain('120 comments\thttps://news.ycombinator.com/item?id=1');
    expect(out).not.toContain('javascript:');
  });

  it('shows JSON and text as they are', async () => {
    const { browser } = site({ 'https://api.test/x': { body: '{"a":1}', type: 'application/json' } });
    const r = await run(browser, 'open', 'https://api.test/x');
    expect(r.out).toContain('(application/json)');
    expect((await run(browser, 'text')).out).toBe('{"a":1}\n');
  });

  it('pages through elements with scroll', async () => {
    const many = `<title>Many</title>${Array.from({ length: 95 }, (_, i) => `<a href="/${i}">link ${i + 1}</a>`).join('')}`;
    const { browser } = site({ 'https://many.test/': { body: many } });
    await run(browser, 'open', 'https://many.test/');
    expect((await run(browser, 'state')).out).toContain('elements 1–40 of 95');
    await run(browser, 'scroll', 'down');
    expect((await run(browser, 'state')).out).toContain('[41] <a href="/40"> link 41');
    await run(browser, 'scroll', 'bottom');
    expect((await run(browser, 'state')).out).toContain('elements 81–95 of 95');
  });

  it('exits 1 on an HTTP error page and reports fetch errors', async () => {
    const { browser } = site({});
    expect((await run(browser, 'open', 'https://nothing.test/')).code).toBe(1);
    const failing = createBrowserCommand({ parseHtml, fetchPage: async () => Promise.reject(new Error('refusing 10.0.0.1: not a public address')) });
    const r = await run(failing, 'open', 'http://10.0.0.1/');
    expect(r.code).toBe(1);
    expect(r.err).toContain('not a public address');
  });

  it('needs an open page', async () => {
    const { browser } = site({});
    expect((await run(browser, 'text')).err).toContain('no page open');
  });
});

describe('browser text extraction', () => {
  it('keeps table rows on one line, separates adjacent links, shows only the chosen option', async () => {
    const html = `<html><head><title>T</title></head><body><table><tr><td><span>1.</span></td> <td><center><a href="v"><div class="votearrow"></div></a></center></td><td><a href="x">Story</a></td></tr></table>
<b><a href="news">Hacker News</a></b><a href="new">new</a> (<a href="s">site.com</a>)
<form><select name="r"><option>Argentina</option><option selected>India</option><option>Peru</option></select></form></body></html>`;
    const { browser } = site({ 'https://t.test/': { body: html } });
    await run(browser, 'open', 'https://t.test/');
    const { out } = await run(browser, 'text');
    expect(out).toContain('1. Story');
    expect(out).toContain('Hacker News new (site.com)');
    expect(out).toContain('India');
    expect(out).not.toContain('Argentina');
  });
});
