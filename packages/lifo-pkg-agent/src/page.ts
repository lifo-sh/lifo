// A loaded page for the text browser: the parsed document, its readable text, and its
// interactive elements numbered the way `browser state` shows them. Nothing on the page runs:
// no scripts, no styles beyond `hidden` and inline display:none, no layout. Pages that build
// themselves with JavaScript show little; server-rendered pages (news, docs, search results,
// Wikipedia, most blogs) read fine.

export interface PageSource {
  url: string;
  status: number;
  contentType: string;
  body: string;
  truncated?: boolean;
}

export type ParseHtml = (html: string) => Document;

const SKIP = new Set(['script', 'style', 'noscript', 'template', 'head', 'svg', 'canvas', 'iframe', 'object', 'embed', 'math']);
const BLOCK = new Set([
  'address', 'article', 'aside', 'blockquote', 'body', 'caption', 'dd', 'details', 'dialog', 'div', 'dl', 'dt',
  'fieldset', 'figcaption', 'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hr', 'html', 'legend',
  'li', 'main', 'menu', 'nav', 'ol', 'p', 'pre', 'section', 'summary', 'table', 'tbody', 'tfoot', 'thead', 'tr', 'ul',
]);
const INTERACTIVE = 'a[href], button, input, select, textarea, summary, [role="button"], [role="link"], [role="tab"], [role="menuitem"]';

export const clean = (s: unknown, max = 120) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
};

function hidden(el: Element): boolean {
  if (SKIP.has(el.localName)) return true;
  if (el.hasAttribute('hidden') || el.getAttribute('aria-hidden') === 'true') return true;
  if (el.localName === 'input' && (el.getAttribute('type') ?? '').toLowerCase() === 'hidden') return true;
  const style = (el.getAttribute('style') ?? '').replace(/\s+/g, '').toLowerCase();
  return style.includes('display:none') || style.includes('visibility:hidden');
}

function visible(el: Element): boolean {
  for (let e: Element | null = el; e; e = e.parentElement) if (hidden(e)) return false;
  return true;
}

/** Readable text: one line per block, cells separated by spaces, scripts and hidden parts left out. */
export function pageText(doc: Document): string {
  const lines: string[] = [];
  let line = '';
  const flush = () => {
    const t = line.replace(/[ \t]+/g, ' ').trim();
    if (t) lines.push(t);
    line = '';
  };
  const walk = (node: Node, pre: boolean) => {
    if (node.nodeType === 3) {
      const v = node.nodeValue ?? '';
      if (pre) {
        const parts = v.split('\n');
        parts.forEach((p, i) => {
          if (i > 0) flush();
          line += p;
        });
      } else line += v.replace(/\s+/g, ' ');
      return;
    }
    if (node.nodeType !== 1) return;
    const el = node as Element;
    if (hidden(el)) return;
    const tag = el.localName;
    if (tag === 'br') return flush();
    if (tag === 'img') {
      const alt = clean(el.getAttribute('alt'), 80);
      if (alt) line += ` ${alt} `;
      return;
    }
    if (tag === 'input') {
      const type = (el.getAttribute('type') ?? 'text').toLowerCase();
      if (type === 'submit' || type === 'button') line += ` [${clean(el.getAttribute('value') || type)}] `;
      return;
    }
    if (tag === 'select') {
      // Only the chosen option, not every option's text.
      const opt = selectedOption(el);
      if (opt) line += ` ${clean(opt.textContent, 60)} `;
      return;
    }
    // Links and buttons sit next to each other without spaces in a lot of markup ("Hacker Newsnew");
    // a browser separates them with CSS, so add a space after a word character.
    if ((tag === 'a' || tag === 'button') && /\w$/.test(line)) line += ' ';
    // An empty block (an icon's <div>, a spacer) would only break the line it sits in.
    const block = BLOCK.has(tag) && !!(el.textContent ?? '').trim();
    if (block) flush();
    if (tag === 'li') line += '• ';
    for (const child of Array.from(el.childNodes)) walk(child, pre || tag === 'pre');
    if (tag === 'td' || tag === 'th') line += '  ';
    if (block) flush();
  };
  walk(doc.body ?? doc.documentElement, false);
  flush();
  return lines.join('\n');
}

export function label(el: Element): string {
  const tag = el.localName;
  const img = el.querySelector('img[alt]');
  const own =
    el.getAttribute('aria-label') ||
    (tag === 'input' || tag === 'textarea' || tag === 'select' ? '' : el.textContent) ||
    (tag === 'input' && ['submit', 'button', 'reset'].includes((el.getAttribute('type') ?? '').toLowerCase()) ? el.getAttribute('value') : '') ||
    el.getAttribute('title') ||
    img?.getAttribute('alt') ||
    '';
  return clean(own, 100);
}

/** The <label> text for a form field, if any. */
function fieldLabel(el: Element): string {
  const id = el.getAttribute('id');
  const doc = el.ownerDocument;
  const byFor = id ? doc.querySelector(`label[for="${CSS_escape(id)}"]`) : null;
  const wrapping = el.closest('label');
  return clean((byFor ?? wrapping)?.textContent ?? '', 60);
}

function CSS_escape(s: string) {
  return s.replace(/["\\]/g, '\\$&');
}

export function inputType(el: Element): string {
  return (el.getAttribute('type') ?? 'text').toLowerCase();
}

/** One `browser state` line: <tag attrs> text */
export function describe(el: Element): string {
  const tag = el.localName;
  const attrs: string[] = [];
  const attr = (k: string, v: unknown) => v != null && v !== '' && attrs.push(`${k}="${clean(v, 60)}"`);
  if (tag === 'a') {
    const href = el.getAttribute('href') ?? '';
    attr('href', href.startsWith('javascript:') ? 'javascript:…' : href);
  } else if (tag === 'input') {
    const type = inputType(el);
    attr('type', type);
    attr('name', el.getAttribute('name'));
    attr('placeholder', el.getAttribute('placeholder') || fieldLabel(el));
    if (type === 'checkbox' || type === 'radio') attrs.push(el.hasAttribute('checked') ? 'checked' : 'unchecked');
    else attr('value', type === 'password' && el.getAttribute('value') ? '••••' : el.getAttribute('value'));
  } else if (tag === 'textarea') {
    attr('name', el.getAttribute('name'));
    attr('placeholder', el.getAttribute('placeholder') || fieldLabel(el));
    attr('value', el.textContent);
  } else if (tag === 'select') {
    attr('name', el.getAttribute('name'));
    attr('selected', selectedOption(el)?.textContent);
  } else if (el.getAttribute('role')) {
    attr('role', el.getAttribute('role'));
  }
  const text = label(el);
  return `<${tag}${attrs.length ? ' ' + attrs.join(' ') : ''}>${text ? ' ' + text : ''}`;
}

export function selectedOption(select: Element): Element | null {
  return select.querySelector('option[selected]') ?? select.querySelector('option');
}

export interface Page {
  url: string;
  status: number;
  contentType: string;
  title: string;
  /** The parsed document (null for plain text and JSON). Form edits are written into it. */
  doc: Document | null;
  /** Plain text and JSON bodies as they came. */
  raw: string;
  truncated: boolean;
  elements: Element[];
}

export function loadPage(src: PageSource, parse: ParseHtml | null): Page {
  const mime = src.contentType.split(';')[0].trim().toLowerCase();
  const html = mime === 'text/html' || mime === 'application/xhtml+xml' || (!mime && /^\s*</.test(src.body));
  if (!html || !parse) {
    return { url: src.url, status: src.status, contentType: mime, title: '', doc: null, raw: src.body, truncated: !!src.truncated, elements: [] };
  }
  const doc = parse(src.body);
  const elements = Array.from(doc.querySelectorAll(INTERACTIVE)).filter((el) => {
    if (!visible(el)) return false;
    if (el.localName === 'a' && (el.getAttribute('href') ?? '').trim() === '') return false;
    return true;
  });
  return {
    url: src.url,
    status: src.status,
    contentType: mime,
    title: clean(doc.querySelector('title')?.textContent ?? '', 200),
    doc,
    raw: '',
    truncated: !!src.truncated,
    elements,
  };
}

/** The page's base for relative links: <base href> if present, else its URL. */
export function baseUrl(page: Page): string {
  const base = page.doc?.querySelector('base[href]')?.getAttribute('href');
  try {
    return base ? new URL(base, page.url).href : page.url;
  } catch {
    return page.url;
  }
}

export function resolveHref(page: Page, href: string): string | null {
  try {
    return new URL(href, baseUrl(page)).href;
  } catch {
    return null;
  }
}

export function links(page: Page): Array<[string, string]> {
  if (!page.doc) return [];
  const out: Array<[string, string]> = [];
  for (const a of Array.from(page.doc.querySelectorAll('a[href]'))) {
    const href = a.getAttribute('href') ?? '';
    if (!href || href.startsWith('javascript:') || !visible(a)) continue;
    const abs = resolveHref(page, href);
    if (abs) out.push([label(a), abs]);
  }
  return out;
}

/** The form an element submits, if any (its ancestor <form>, or the one its form="" names). */
export function formOf(el: Element): HTMLFormElement | null {
  const id = el.getAttribute('form');
  if (id) return (el.ownerDocument.getElementById(id) as HTMLFormElement | null) ?? null;
  return el.closest('form') as HTMLFormElement | null;
}

/** The URL a GET form submits to, with its fields (and the submit button, if one was clicked). */
export function formUrl(page: Page, form: Element, submitter?: Element): { url: string } | { error: string } {
  const method = (form.getAttribute('method') ?? 'get').toLowerCase();
  if (method !== 'get') return { error: `this form sends a ${method.toUpperCase()} request; the text browser only reads pages (GET)` };
  const action = resolveHref(page, form.getAttribute('action') || page.url);
  if (!action) return { error: 'the form has an invalid action URL' };
  const params = new URLSearchParams();
  const doc = form.ownerDocument;
  const id = form.getAttribute('id');
  const fields = [
    ...Array.from(form.querySelectorAll('input, select, textarea')),
    ...(id ? Array.from(doc.querySelectorAll(`[form="${CSS_escape(id)}"]`)) : []),
  ];
  for (const el of fields) {
    const name = el.getAttribute('name');
    if (!name || el.hasAttribute('disabled')) continue;
    if (el.localName === 'input') {
      const type = inputType(el);
      if (['submit', 'button', 'reset', 'image', 'file'].includes(type)) continue;
      if ((type === 'checkbox' || type === 'radio') && !el.hasAttribute('checked')) continue;
      params.append(name, el.getAttribute('value') ?? (type === 'checkbox' || type === 'radio' ? 'on' : ''));
    } else if (el.localName === 'select') {
      const opt = selectedOption(el);
      if (opt) params.append(name, opt.getAttribute('value') ?? opt.textContent ?? '');
    } else if (el.localName === 'textarea') {
      params.append(name, el.textContent ?? '');
    }
  }
  const sName = submitter?.getAttribute('name');
  if (submitter && sName) params.append(sName, submitter.getAttribute('value') ?? '');
  const u = new URL(action);
  u.search = params.toString();
  u.hash = '';
  return { url: u.href };
}

/** Text fields `browser type` can fill. */
export function isTextField(el: Element): boolean {
  if (el.localName === 'textarea') return true;
  if (el.localName !== 'input') return false;
  return !['submit', 'button', 'reset', 'image', 'file', 'checkbox', 'radio', 'hidden', 'range', 'color'].includes(inputType(el));
}

export function fieldNames(el: Element): string[] {
  return [el.getAttribute('name'), el.getAttribute('id'), el.getAttribute('placeholder'), el.getAttribute('aria-label'), fieldLabel(el)]
    .filter((s): s is string => !!s)
    .map((s) => s.toLowerCase().trim());
}
