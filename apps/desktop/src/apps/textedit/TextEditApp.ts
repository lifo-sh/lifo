// TextEdit: edit text files in the box. Save with ⌘S, Save As to any path, open from Finder or
// by path. The title shows the file name and "Edited" while there are unsaved changes; closing
// asks to save. If the file changes on disk (say, from a Terminal) and you haven't edited it,
// the new contents load by themselves.

import type { AppDefinition, AppContext, AppInstance, MenuCategory } from '../../types';
import type { DesktopWindow } from '../../core/Window';
import { APP_ICONS } from '../../icons';
import { h, promptDialog, choiceDialog } from '../../core/ui';
import { HOME, basename, dirname } from '../../core/box';

class TextEditInstance implements AppInstance {
  readonly appId = 'textedit';
  private win!: DesktopWindow;
  private area!: HTMLTextAreaElement;
  private status!: HTMLElement;
  private dirty = false;
  private saved = '';
  private unwatch: (() => void) | null = null;
  private wrap = true;
  private mono = true;
  private size = 14;

  constructor(private ctx: AppContext, private path: string | null = null) {
    // A folder can't be edited; a path that doesn't exist yet is a new file saved there.
    if (path && ctx.box.vfs.exists(path) && ctx.box.vfs.stat(path).type === 'directory') this.path = null;
  }

  mount(container: HTMLElement, win: DesktopWindow): void {
    this.win = win;
    this.area = h('textarea', { class: 'lf-textedit-area', spellcheck: 'false', 'aria-label': 'Document' }) as HTMLTextAreaElement;
    this.status = h('div', { class: 'lf-statusbar' });
    container.append(h('div', { class: 'lf-textedit' }, this.area, this.status));
    this.load();
    this.applyStyle();

    this.area.addEventListener('input', () => this.setDirty(this.area.value !== this.saved));
    this.area.addEventListener('keyup', () => this.updateStatus());
    this.area.addEventListener('click', () => this.updateStatus());
    this.area.addEventListener('keydown', (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        void (e.shiftKey ? this.saveAs() : this.save());
      } else if (e.key === 'Tab' && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        document.execCommand('insertText', false, '  ');
      }
    });
  }

  private load(): void {
    const vfs = this.ctx.box.vfs;
    this.unwatch?.();
    this.unwatch = null;
    if (this.path && vfs.exists(this.path)) {
      try {
        this.saved = vfs.readFileString(this.path);
      } catch {
        this.saved = '';
      }
      this.unwatch = vfs.watch(this.path, () => {
        if (this.dirty || !this.path || !vfs.exists(this.path)) return;
        const now = vfs.readFileString(this.path);
        if (now !== this.area.value) {
          this.saved = now;
          this.area.value = now;
          this.updateStatus();
        }
      });
    } else this.saved = '';
    this.area.value = this.saved;
    this.setDirty(false);
  }

  private setDirty(d: boolean): void {
    this.dirty = d;
    this.win.el.classList.toggle('edited', d);
    this.ctx.windowManager.setTitle(this.win.state.id, this.getTitle());
    this.updateStatus();
  }

  private updateStatus(): void {
    const v = this.area.value;
    const before = v.slice(0, this.area.selectionStart);
    const line = before.split('\n').length;
    const col = before.length - before.lastIndexOf('\n');
    this.status.textContent = `${this.path ? this.path.replace(HOME, '~') : 'Not saved'} · Ln ${line}, Col ${col} · ${v.length} characters`;
  }

  private applyStyle(): void {
    this.area.style.whiteSpace = this.wrap ? 'pre-wrap' : 'pre';
    this.area.style.fontSize = `${this.size}px`;
    this.area.classList.toggle('mono', this.mono);
  }

  async save(): Promise<boolean> {
    if (!this.path) return this.saveAs();
    const vfs = this.ctx.box.vfs;
    const dir = dirname(this.path);
    if (!vfs.exists(dir)) vfs.mkdir(dir, { recursive: true });
    vfs.writeFile(this.path, this.area.value);
    this.saved = this.area.value;
    this.setDirty(false);
    if (!this.unwatch) this.load();
    return true;
  }

  async saveAs(): Promise<boolean> {
    const suggestion = this.path ?? `${HOME}/Documents/Untitled.txt`;
    const p = await promptDialog('Save As', 'Path in the box', suggestion.replace(HOME, '~'), 'Save');
    if (!p) return false;
    this.path = p.replace(/^~/, HOME);
    return this.save();
  }

  private async open(): Promise<void> {
    if (!(await this.canClose())) return;
    const p = await promptDialog('Open', 'Path of a file in the box', '~/', 'Open');
    if (!p) return;
    this.path = p.replace(/^~/, HOME);
    this.load();
  }

  async canClose(): Promise<boolean> {
    if (!this.dirty) return true;
    const choice = await choiceDialog(
      `Save changes to “${this.path ? basename(this.path) : 'Untitled'}”?`,
      "Your changes will be lost if you don't save them.",
      [{ label: "Don't Save", danger: true }, { label: 'Cancel' }, { label: 'Save', primary: true }],
    );
    if (choice === 0) return true;
    if (choice === 2) return this.save();
    return false;
  }

  unmount(): void {
    this.unwatch?.();
  }

  focus(): void {
    this.area?.focus({ preventScroll: true });
  }

  getTitle(): string {
    const name = this.path ? basename(this.path) : 'Untitled';
    return this.dirty ? `${name} — Edited` : name;
  }

  getMenus(): MenuCategory[] {
    return [
      {
        label: 'File',
        items: [
          { label: 'New', shortcut: '⌥N', action: () => this.ctx.launch('textedit') },
          { label: 'Open…', action: () => void this.open() },
          { separator: true, label: '' },
          { label: 'Save', shortcut: '⌘S', action: () => void this.save() },
          { label: 'Save As…', shortcut: '⇧⌘S', action: () => void this.saveAs() },
          { label: 'Revert to Saved', disabled: !this.dirty, action: () => this.load() },
          { separator: true, label: '' },
          { label: 'Show in Finder', disabled: !this.path, action: () => this.path && this.ctx.launch('finder', this.path) },
          { label: 'Open in Terminal', disabled: !this.path, action: () => this.path && this.ctx.launch('terminal', dirname(this.path)) },
        ],
      },
      {
        label: 'Format',
        items: [
          { label: 'Wrap Lines', checked: this.wrap, action: () => ((this.wrap = !this.wrap), this.applyStyle()) },
          { label: 'Monospaced Font', checked: this.mono, action: () => ((this.mono = !this.mono), this.applyStyle()) },
          { separator: true, label: '' },
          { label: 'Bigger', action: () => ((this.size = Math.min(28, this.size + 1)), this.applyStyle()) },
          { label: 'Smaller', action: () => ((this.size = Math.max(10, this.size - 1)), this.applyStyle()) },
        ],
      },
    ];
  }
}

export const textEditDefinition: AppDefinition = {
  id: 'textedit',
  name: 'TextEdit',
  icon: APP_ICONS.textedit,
  extensions: ['.txt', '.md', '.json', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.css', '.html', '.py', '.sh', '.yml', '.yaml', '.toml', '.env', '.csv', '.xml', '.svg', '.liforc', '.bashrc'],
  size: { width: 680, height: 480 },
  minSize: { width: 320, height: 200 },
  createInstance: (ctx, arg) => new TextEditInstance(ctx, arg ?? null),
};
