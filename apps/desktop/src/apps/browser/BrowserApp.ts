// Browser: shows servers running in the box (localhost:<port>), through Lifo's preview service
// worker, plus HTML files from Finder. The start page lists listening ports and can start a
// sample server. Public sites usually refuse to be framed, so it's for the box's own servers.

import type { AppDefinition, AppContext, AppInstance, MenuCategory } from '../../types';
import type { DesktopWindow } from '../../core/Window';
import { APP_ICONS, GLYPHS } from '../../icons';
import { h, svg } from '../../core/ui';
import { HOME, basename } from '../../core/box';

const SAMPLE_DIR = `${HOME}/Projects/hello-server`;
const SAMPLE = `const http = require('http');
let visits = 0;
http.createServer((req, res) => {
  visits++;
  res.setHeader('content-type', 'text/html');
  res.end(\`<!doctype html><body style="font:16px system-ui;padding:40px;background:#0f1020;color:#e6e6ef">
  <h1>Hello from a server inside Lifo</h1>
  <p>This page is served by <code>node server.js</code>, running in your browser tab.</p>
  <p>Visit #\${visits} · path <code>\${req.url}</code></p>
  <p>Edit <code>~/Projects/hello-server/server.js</code> in TextEdit, then restart it in Terminal.</p>\`);
}).listen(3000, () => console.log('listening on http://localhost:3000'));
`;

class BrowserInstance implements AppInstance {
  readonly appId = 'browser';
  private win!: DesktopWindow;
  private frame!: HTMLIFrameElement;
  private address!: HTMLInputElement;
  private start!: HTMLElement;
  private current: { port: number; path: string } | null = null;
  private poll = 0;

  constructor(private ctx: AppContext, private arg?: string) {}

  mount(container: HTMLElement, win: DesktopWindow): void {
    this.win = win;
    const btn = (glyph: string, title: string, onclick: () => void) => h('button', { class: 'lf-tb-btn', title, 'aria-label': title, onclick }, svg(glyph));
    this.address = h('input', { class: 'lf-address', placeholder: 'localhost:3000', spellcheck: 'false', 'aria-label': 'Address' }) as HTMLInputElement;
    this.address.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') void this.go(this.address.value);
    });
    this.address.addEventListener('focus', () => this.address.select());
    this.frame = h('iframe', { class: 'lf-browser-frame', title: 'Page', sandbox: 'allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-downloads' }) as HTMLIFrameElement;
    this.frame.addEventListener('load', () => this.syncAddress());
    this.start = h('div', { class: 'lf-browser-start' });
    const toolbar = h(
      'div',
      { class: 'lf-toolbar browser', 'data-drag': '' },
      h('div', { class: 'lf-tb-group' }, btn(GLYPHS.back, 'Back', () => this.history(-1)), btn(GLYPHS.forward, 'Forward', () => this.history(1))),
      btn(GLYPHS.reload, 'Reload', () => this.reload()),
      h('div', { class: 'lf-address-wrap', 'data-nodrag': '' }, svg(GLYPHS.globe), this.address),
      btn(GLYPHS.home, 'Start Page', () => this.showStart()),
    );
    container.append(h('div', { class: 'lf-browser' }, toolbar, h('div', { class: 'lf-browser-body' }, this.frame, this.start)));

    const a = this.arg;
    if (a && /\.html?$/i.test(a) && this.ctx.box.vfs.exists(a)) this.showFile(a);
    else if (a) void this.go(a);
    else {
      const ports = this.ctx.box.ports();
      if (ports.length === 1) void this.go(String(ports[0]));
      else this.showStart();
    }
  }

  private parse(input: string): { port: number; path: string } | { url: string } | null {
    const s = input.trim();
    if (/^\d{2,5}$/.test(s)) return { port: Number(s), path: '/' };
    const m = s.match(/^(?:https?:\/\/)?(?:localhost|127\.0\.0\.1|0\.0\.0\.0)?:(\d{2,5})(\/.*)?$/);
    if (m) return { port: Number(m[1]), path: m[2] || '/' };
    if (/^https?:\/\//.test(s)) return { url: s };
    if (/^[\w.-]+\.[a-z]{2,}(\/.*)?$/i.test(s)) return { url: `https://${s}` };
    return null;
  }

  async go(input: string): Promise<void> {
    const target = this.parse(input);
    if (!target) {
      this.address.value = input;
      return;
    }
    if ('url' in target) {
      this.current = null;
      this.showFrame();
      this.frame.removeAttribute('srcdoc');
      this.frame.src = target.url;
      this.address.value = target.url;
      this.title(new URL(target.url).host);
      return;
    }
    const url = await this.ctx.box.previewUrl(target.port, target.path);
    if (!url) {
      this.showStart('Previews need service workers, which this browser has turned off (private window or blocked site data).');
      return;
    }
    this.current = target;
    this.showFrame();
    this.frame.removeAttribute('srcdoc');
    this.frame.src = url;
    this.address.value = `localhost:${target.port}${target.path === '/' ? '' : target.path}`;
    this.title(`localhost:${target.port}`);
  }

  private showFile(path: string): void {
    this.current = null;
    this.showFrame();
    this.frame.removeAttribute('src');
    this.frame.srcdoc = this.ctx.box.vfs.readFileString(path);
    this.address.value = `file://${path}`;
    this.title(basename(path));
  }

  private syncAddress(): void {
    try {
      const loc = this.frame.contentWindow?.location;
      const m = loc?.pathname.match(/^\/_sw\/[^/]+\/(\d+)(\/.*)?$/);
      if (m) {
        this.current = { port: Number(m[1]), path: (m[2] || '/') + (loc!.search || '') };
        if (document.activeElement !== this.address) this.address.value = `localhost:${m[1]}${this.current.path === '/' ? '' : this.current.path}`;
        const t = this.frame.contentDocument?.title;
        this.title(t || `localhost:${m[1]}`);
      }
    } catch {
      /* cross-origin page */
    }
  }

  private history(d: number): void {
    try {
      this.frame.contentWindow?.history.go(d);
    } catch {
      /* cross-origin */
    }
  }

  private reload(): void {
    if (this.start.classList.contains('visible')) return this.renderStart();
    try {
      this.frame.contentWindow?.location.reload();
    } catch {
      this.frame.src = this.frame.src;
    }
  }

  private title(t: string): void {
    this.ctx.windowManager.setTitle(this.win.state.id, t);
  }

  private showFrame(): void {
    this.start.classList.remove('visible');
    clearInterval(this.poll);
  }

  private notice = '';

  showStart(notice = ''): void {
    this.notice = notice;
    this.frame.removeAttribute('src');
    this.frame.removeAttribute('srcdoc');
    this.address.value = '';
    this.title('Browser');
    this.start.classList.add('visible');
    this.renderStart();
    clearInterval(this.poll);
    this.poll = window.setInterval(() => this.renderStart(), 1500);
  }

  private renderStart(): void {
    const ports = this.ctx.box.ports();
    const cards = ports.map((p) =>
      h('button', { class: 'lf-port-card', onclick: () => void this.go(String(p)) }, svg(GLYPHS.server), h('b', {}, `localhost:${p}`), h('small', {}, 'Open')),
    );
    this.start.replaceChildren(
      h('div', { class: 'lf-browser-hero' }, h('div', { class: 'lf-browser-logo', html: APP_ICONS.browser }), h('h2', {}, 'Servers in this box'), h('p', {}, 'Anything listening on a port inside Lifo shows up here, served from this tab.')),
      ...(this.notice ? [h('p', { class: 'lf-notice' }, this.notice)] : []),
      cards.length ? h('div', { class: 'lf-port-grid' }, ...cards) : h('p', { class: 'lf-muted' }, 'Nothing is listening yet. Start a server in Terminal (for example npx serve, or node server.js), or:'),
      h(
        'div',
        { class: 'lf-browser-actions' },
        h('button', { class: 'lf-btn primary', onclick: () => void this.startSample() }, 'Start a sample server'),
        h('button', { class: 'lf-btn', onclick: () => this.ctx.launch('terminal', HOME) }, 'Open Terminal'),
      ),
    );
  }

  private async startSample(): Promise<void> {
    const vfs = this.ctx.box.vfs;
    if (!vfs.exists(SAMPLE_DIR)) vfs.mkdir(SAMPLE_DIR, { recursive: true });
    if (!vfs.exists(`${SAMPLE_DIR}/server.js`)) vfs.writeFile(`${SAMPLE_DIR}/server.js`, SAMPLE);
    if (!this.ctx.box.ports().includes(3000)) await this.ctx.box.startInBackground('node server.js', SAMPLE_DIR);
    try {
      await this.ctx.box.sandbox.waitForPort(3000, { timeout: 10000 });
      await this.go('3000');
    } catch {
      this.showStart('The sample server did not start; try `node server.js` in ~/Projects/hello-server.');
    }
  }

  unmount(): void {
    clearInterval(this.poll);
  }

  getTitle(): string {
    return 'Browser';
  }

  getMenus(): MenuCategory[] {
    return [
      {
        label: 'File',
        items: [
          { label: 'New Window', shortcut: '⌥N', action: () => this.ctx.launch('browser') },
          { label: 'Open Location…', action: () => this.address.focus() },
        ],
      },
      {
        label: 'View',
        items: [
          { label: 'Reload Page', action: () => this.reload() },
          { label: 'Start Page', action: () => this.showStart() },
        ],
      },
      {
        label: 'History',
        items: [
          { label: 'Back', action: () => this.history(-1) },
          { label: 'Forward', action: () => this.history(1) },
        ],
      },
    ];
  }
}

export const browserDefinition: AppDefinition = {
  id: 'browser',
  name: 'Browser',
  icon: APP_ICONS.browser,
  chrome: 'unified',
  extensions: ['.html', '.htm'],
  size: { width: 900, height: 600 },
  minSize: { width: 420, height: 300 },
  createInstance: (ctx, arg) => new BrowserInstance(ctx, arg),
};
