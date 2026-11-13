// Runs INSIDE Firefox, in the privileged browser-chrome context (browser.xhtml), via evalChrome.
//
// installHelpers is serialized with Function.prototype.toString() and evaluated there, so it must be
// fully self-contained: no imports, no references to anything outside its own body. It installs
// window.__bu, whose `call(name, args)` returns a JSON string {ok, v} or {ok:false, e}.
//
// This Firefox build runs tabs in-process, so chrome code can reach the page's DOM directly through
// gBrowser.selectedBrowser.contentDocument, much like Puppeteer's page handle.

/* eslint-disable @typescript-eslint/no-explicit-any */
declare const gBrowser: any;
declare const Services: any;
declare const Cu: any;
declare const Cc: any;
declare const Ci: any;

export function installHelpers(): string {
  const w = window as any;
  const XHTML = 'http://www.w3.org/1999/xhtml';
  const INTERACTIVE =
    'a[href], button, input:not([type=hidden]), textarea, select, summary, [role=button], [role=link], ' +
    '[role=tab], [role=menuitem], [role=checkbox], [role=radio], [role=option], [role=switch], [onclick], ' +
    '[contenteditable=""], [contenteditable=true]';
  const COLORS = ['#e11d48', '#2563eb', '#16a34a', '#d97706', '#7c3aed', '#0891b2', '#db2777', '#4d7c0f'];

  const browser = () => gBrowser.selectedBrowser;
  const doc = () => browser().contentDocument;
  const win = () => browser().contentWindow;
  const clean = (s: unknown, n = 80) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
  const bu: any = { version: 1, els: [] as any[] };

  function visible(el: any, all: boolean) {
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    const vw = win().innerWidth;
    const vh = win().innerHeight;
    if (!all && (r.bottom < 0 || r.top > vh || r.right < 0 || r.left > vw)) return false;
    const cs = win().getComputedStyle(el);
    return cs.visibility !== 'hidden' && cs.display !== 'none' && Number(cs.opacity) > 0;
  }

  function label(el: any) {
    const img = el.querySelector?.('img[alt]');
    return clean(
      el.getAttribute('aria-label') ||
        (el.localName === 'input' || el.localName === 'textarea' ? '' : el.innerText) ||
        el.getAttribute('title') ||
        (img && img.getAttribute('alt')) ||
        '',
    );
  }

  function describe(el: any) {
    const tag = el.localName;
    const attrs: string[] = [];
    const attr = (k: string, v: unknown) => v != null && v !== '' && attrs.push(`${k}="${clean(v, 60)}"`);
    if (tag === 'a') {
      const href = el.getAttribute('href') || '';
      attr('href', href.startsWith('javascript:') ? 'javascript:…' : href);
    } else if (tag === 'input') {
      attr('type', el.type);
      attr('name', el.name);
      attr('placeholder', el.placeholder);
      if (el.type === 'checkbox' || el.type === 'radio') attrs.push(el.checked ? 'checked' : 'unchecked');
      else attr('value', el.type === 'password' && el.value ? '••••' : el.value);
    } else if (tag === 'textarea') {
      attr('name', el.name);
      attr('placeholder', el.placeholder);
      attr('value', el.value);
    } else if (tag === 'select') {
      attr('name', el.name);
      attr('selected', el.selectedOptions?.[0]?.textContent);
    } else if (el.getAttribute('role')) {
      attr('role', el.getAttribute('role'));
    }
    const text = label(el);
    return `<${tag}${attrs.length ? ' ' + attrs.join(' ') : ''}>${text ? ' ' + text : ''}`;
  }

  function clearOverlay() {
    doc()?.getElementById('__bu_overlay')?.remove();
  }

  function drawOverlay(els: any[]) {
    const d = doc();
    const root = d.createElement('div');
    root.id = '__bu_overlay';
    root.style.cssText = 'position:absolute;left:0;top:0;width:0;height:0;z-index:2147483647;pointer-events:none';
    const sx = win().scrollX;
    const sy = win().scrollY;
    els.forEach((el, i) => {
      const r = el.getBoundingClientRect();
      const c = COLORS[i % COLORS.length];
      const box = d.createElement('div');
      box.style.cssText = `position:absolute;left:${r.left + sx}px;top:${r.top + sy}px;width:${r.width}px;height:${r.height}px;outline:2px solid ${c};outline-offset:-1px;background:${c}14;pointer-events:none`;
      const tag = d.createElement('div');
      tag.textContent = String(i + 1);
      tag.style.cssText = `position:absolute;right:-2px;top:-14px;background:${c};color:#fff;font:600 10px/14px ui-monospace,Menlo,monospace;padding:0 3px;border-radius:3px;pointer-events:none`;
      box.appendChild(tag);
      root.appendChild(box);
    });
    (d.body || d.documentElement).appendChild(root);
  }

  function info() {
    const d = doc();
    const wv = win();
    return {
      url: gBrowser.currentURI?.spec || '',
      title: d?.title || '',
      loading: !!browser().webProgress?.isLoadingDocument,
      ready: d?.readyState || '',
      scrollY: Math.round(wv?.scrollY || 0),
      viewport: wv?.innerHeight || 0,
      height: d?.documentElement?.scrollHeight || 0,
    };
  }

  // A target is an index from the last `state`, a CSS selector, or visible text.
  function resolve(target: string) {
    if (/^\d+$/.test(target)) {
      const el = bu.els[Number(target) - 1];
      if (!el) throw new Error(`no element [${target}]; run \`browser state\` first`);
      if (!el.isConnected) throw new Error(`element [${target}] is gone (page changed); run \`browser state\` again`);
      return el;
    }
    const d = doc();
    // A bare word like "q" is also a valid CSS selector (the <q> tag), so try form-field names and
    // ids first: `browser type q hello` should mean the field named q.
    if (/^[\w-]+$/.test(target)) {
      const byName = [...d.querySelectorAll(`[name="${target}"]`)].find((el: any) => visible(el, true));
      if (byName) return byName;
      const byId = d.getElementById(target);
      if (byId) return byId;
    }
    try {
      const el = d.querySelector(target);
      if (el) return el;
    } catch {
      /* not a selector: match by text below */
    }
    const needle = target.toLowerCase();
    const candidates = [...d.querySelectorAll(INTERACTIVE)].filter((el: any) => visible(el, true));
    const texts = (el: any) =>
      [
        label(el),
        el.getAttribute('placeholder'),
        el.getAttribute('aria-label'),
        el.labels?.[0]?.innerText,
        el.localName === 'input' && /^(submit|button)$/.test(el.type) ? el.value : '',
      ]
        .filter(Boolean)
        .map((t: string) => clean(t, 200).toLowerCase());
    const exact = candidates.find((el: any) => texts(el).some((t: string) => t === needle));
    if (exact) return exact;
    const partial = candidates.filter((el: any) => texts(el).some((t: string) => t.includes(needle)));
    if (!partial.length) throw new Error(`nothing matches "${target}"`);
    // Several partial matches: refuse rather than silently click the first (e.g. "Ask HN" matching
    // a story titled "Ask HN: …" instead of the "ask" link in the nav bar).
    if (partial.length > 1) {
      const list = partial.slice(0, 6).map((el: any) => `  "${clean(texts(el)[0], 70)}"`).join('\n');
      throw new Error(
        `"${target}" matches ${partial.length} elements, not clicking any. Use the exact text, or an index from \`browser state\`:\n${list}`,
      );
    }
    return partial[0];
  }

  bu.info = info;

  bu.state = (all = false, highlight = true) => {
    const d = doc();
    clearOverlay();
    if (!d?.documentElement) return { ...info(), lines: [] };
    const found = [...d.querySelectorAll(INTERACTIVE)].filter((el: any) => visible(el, all));
    const set = new Set(found);
    // Keep the outer element when interactive elements nest (e.g. a <span role=button> inside a link).
    const els = found.filter((el: any) => {
      for (let p = el.parentElement; p; p = p.parentElement) if (set.has(p)) return false;
      return true;
    });
    bu.els = els;
    if (highlight) drawOverlay(els);
    return { ...info(), lines: els.map(describe) };
  };

  bu.goto = (url: string) => {
    clearOverlay();
    browser().fixupAndLoadURIString(url, {
      triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
    });
    return true;
  };
  bu.back = () => (gBrowser.goBack(), true);
  bu.forward = () => (gBrowser.goForward(), true);
  bu.reload = () => (gBrowser.reload(), true);

  bu.click = (target: string) => {
    const el = resolve(target);
    clearOverlay();
    el.scrollIntoView({ block: 'center', inline: 'center' });
    const r = el.getBoundingClientRect();
    const x = r.left + r.width / 2;
    const y = r.top + r.height / 2;
    const hit = doc().elementFromPoint(x, y);
    let how = 'dom';
    // Prefer a real (trusted) mouse click at the element's centre, the way a user would click. If
    // something covers it (a banner, an overlay), fall back to clicking the element directly.
    if (hit && (hit === el || el.contains(hit))) {
      try {
        const u = win().windowUtils;
        u.sendMouseEvent('mousedown', x, y, 0, 1, 0);
        u.sendMouseEvent('mouseup', x, y, 0, 1, 0);
        how = 'mouse';
      } catch {
        el.click();
      }
    } else {
      el.click();
    }
    return { how, target: describe(el) };
  };

  bu.type = (target: string, text: string, append = false) => {
    const el = resolve(target);
    clearOverlay();
    el.scrollIntoView({ block: 'center' });
    el.focus();
    const d = doc();
    if (!append) {
      if (typeof el.select === 'function') el.select();
      else d.execCommand('selectAll');
    }
    // insertText produces real input events, so frameworks like React see the change.
    let ok = false;
    try {
      ok = text ? d.execCommand('insertText', false, text) : d.execCommand('delete');
    } catch {
      ok = false;
    }
    if (!ok && 'value' in el) {
      el.value = (append ? el.value : '') + text;
      el.dispatchEvent(new (win().Event)('input', { bubbles: true }));
      el.dispatchEvent(new (win().Event)('change', { bubbles: true }));
    }
    return { target: describe(el), value: clean(el.value ?? el.textContent, 200) };
  };

  bu.select = (target: string, option: string) => {
    const el = resolve(target);
    if (el.localName !== 'select') throw new Error('not a <select>');
    const opt = [...el.options].find(
      (o: any) => o.value === option || o.textContent.trim().toLowerCase() === option.toLowerCase(),
    );
    if (!opt) throw new Error(`no option "${option}"`);
    el.value = (opt as any).value;
    el.dispatchEvent(new (win().Event)('input', { bubbles: true }));
    el.dispatchEvent(new (win().Event)('change', { bubbles: true }));
    return { target: describe(el) };
  };

  const KEYS: Record<string, [string, number]> = {
    enter: ['Enter', 13], tab: ['Tab', 9], escape: ['Escape', 27], esc: ['Escape', 27],
    backspace: ['Backspace', 8], delete: ['Delete', 46], space: [' ', 32],
    arrowup: ['ArrowUp', 38], arrowdown: ['ArrowDown', 40], arrowleft: ['ArrowLeft', 37], arrowright: ['ArrowRight', 39],
    up: ['ArrowUp', 38], down: ['ArrowDown', 40], left: ['ArrowLeft', 37], right: ['ArrowRight', 39],
    pageup: ['PageUp', 33], pagedown: ['PageDown', 34], home: ['Home', 36], end: ['End', 35],
  };

  bu.key = (name: string) => {
    const k = KEYS[name.toLowerCase()];
    const key = k ? k[0] : name;
    const keyCode = k ? k[1] : name.length === 1 ? name.toUpperCase().charCodeAt(0) : 0;
    const code = key === ' ' ? 'Space' : key.length === 1 ? `Key${key.toUpperCase()}` : key;
    clearOverlay();
    // nsITextInputProcessor dispatches trusted key events, so Enter in a field submits its form.
    try {
      const tip = Cc['@mozilla.org/text-input-processor;1'].createInstance(Ci.nsITextInputProcessor);
      if (!tip.beginInputTransactionForTests(win())) throw new Error('input transaction refused');
      const ev = new (win().KeyboardEvent)('', { key, code, keyCode });
      tip.keydown(ev);
      tip.keyup(ev);
      return { key, how: 'trusted' };
    } catch (e) {
      const active = doc().activeElement;
      if (key === 'Enter' && active?.form) {
        active.form.requestSubmit();
        return { key, how: 'requestSubmit' };
      }
      throw e;
    }
  };

  bu.scroll = (dir: string, px?: number) => {
    const wv = win();
    clearOverlay();
    const step = px || Math.round(wv.innerHeight * 0.8);
    if (dir === 'top') wv.scrollTo(0, 0);
    else if (dir === 'bottom') wv.scrollTo(0, doc().documentElement.scrollHeight);
    else wv.scrollBy(0, dir === 'up' ? -step : step);
    return info();
  };

  bu.text = () => doc()?.body?.innerText ?? '';

  bu.links = () =>
    [...(doc()?.querySelectorAll('a[href]') ?? [])]
      .filter((a: any) => !a.href.startsWith('javascript:'))
      .map((a: any) => [clean(a.innerText || a.getAttribute('aria-label') || a.title, 100), a.href]);

  bu.exists = (selector: string) => !!doc()?.querySelector(selector);

  // Evaluates in a sandbox that shares the page's globals but is exempt from its CSP (sites that
  // forbid eval would otherwise refuse).
  bu.eval = (js: string) => {
    const sb = Cu.Sandbox(win(), { sandboxPrototype: win(), wantXrays: false, sameZoneAs: win() });
    const v = Cu.evalInSandbox(js, sb);
    if (v === undefined) return 'undefined';
    if (typeof v === 'string') return v;
    try {
      return JSON.stringify(v, null, 2) ?? String(v);
    } catch {
      return String(v);
    }
  };

  bu.screenshot = (full = false) => {
    const wv = win();
    clearOverlay();
    const width = wv.innerWidth;
    const height = full ? Math.min(doc().documentElement.scrollHeight, 12000) : wv.innerHeight;
    const canvas = document.createElementNS(XHTML, 'canvas') as HTMLCanvasElement;
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d') as any;
    ctx.drawWindow(wv, full ? 0 : wv.scrollX, full ? 0 : wv.scrollY, width, height, 'white');
    return { dataUrl: canvas.toDataURL('image/png'), width, height };
  };

  bu.call = (name: string, args: unknown[]) => {
    try {
      if (typeof bu[name] !== 'function' || name === 'call') throw new Error(`unknown helper ${name}`);
      return JSON.stringify({ ok: true, v: bu[name](...args) });
    } catch (e: any) {
      return JSON.stringify({ ok: false, e: String(e?.message ?? e) });
    }
  };

  w.__bu = bu;
  return 'installed';
}
