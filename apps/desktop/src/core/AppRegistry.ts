import type { AppDefinition, AppContext, AppInstance } from '../types';

export class AppRegistry {
  private apps = new Map<string, AppDefinition>();

  register(def: AppDefinition): void {
    this.apps.set(def.id, def);
  }

  get(appId: string): AppDefinition | undefined {
    return this.apps.get(appId);
  }

  getAll(): AppDefinition[] {
    return [...this.apps.values()];
  }

  /** Apps that can open this file, best first (TextEdit always last as the fallback). */
  appsForFile(path: string): AppDefinition[] {
    const ext = path.includes('.') ? '.' + path.split('.').pop()!.toLowerCase() : '';
    const list = this.getAll().filter((a) => ext && a.extensions?.includes(ext));
    const textedit = this.apps.get('textedit');
    if (textedit && !list.includes(textedit)) list.push(textedit);
    return list;
  }

  /** Open a new window of `appId` (or focus the existing one for single-window apps). */
  launch(appId: string, ctx: AppContext, arg?: string): AppInstance | null {
    const def = this.apps.get(appId);
    if (!def) return null;
    if (def.singleton) {
      const existing = ctx.windowManager.getWindowsByApp(appId)[0];
      if (existing) {
        ctx.windowManager.focusWindow(existing.state.id);
        return existing.appInstance;
      }
    }
    ctx.eventBus.emit('app:launch', { appId });
    const instance = def.createInstance(ctx, arg);
    ctx.windowManager.createWindow(def, instance);
    return instance;
  }
}
