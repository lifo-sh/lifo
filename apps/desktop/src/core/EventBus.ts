export interface DesktopEvents {
  'window:open': { windowId: string; appId: string };
  'window:close': { windowId: string; appId: string };
  'window:focus': { windowId: string; appId: string };
  'window:minimize': { windowId: string; appId: string };
  'window:restore': { windowId: string; appId: string };
  'window:maximize': { windowId: string };
  'window:title': { windowId: string; title: string };
  /** Focus left every window (desktop clicked, last window closed). */
  'desktop:focus': {};
  'app:launch': { appId: string };
  'menu:update': {};
  'settings:change': {};
  'trash:change': {};
}

type EventHandler<T = unknown> = (data: T) => void;

export class EventBus {
  private handlers = new Map<string, Set<EventHandler>>();

  on<K extends keyof DesktopEvents>(event: K, handler: EventHandler<DesktopEvents[K]>): () => void {
    if (!this.handlers.has(event)) this.handlers.set(event, new Set());
    const set = this.handlers.get(event)!;
    set.add(handler as EventHandler);
    return () => set.delete(handler as EventHandler);
  }

  emit<K extends keyof DesktopEvents>(event: K, data: DesktopEvents[K]): void {
    for (const handler of this.handlers.get(event) ?? []) handler(data);
  }
}
