// Desktop settings and remembered layout, kept in localStorage. Every read and write is guarded:
// private windows and blocked storage just fall back to the defaults.

export type Appearance = 'dark' | 'light' | 'auto';

export interface SettingsData {
  appearance: Appearance;
  wallpaper: string;
  dockSize: number;
  magnification: boolean;
  magnifiedSize: number;
  showDesktopIcons: boolean;
}

const DEFAULTS: SettingsData = {
  appearance: 'dark',
  wallpaper: 'lifo-night',
  dockSize: 50,
  magnification: true,
  magnifiedSize: 84,
  showDesktopIcons: true,
};

const KEY = 'lifo-desktop:settings';
const BOUNDS_KEY = 'lifo-desktop:bounds';

function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? { ...fallback, ...JSON.parse(raw) } : fallback;
  } catch {
    return fallback;
  }
}

function write(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage unavailable: the change lasts for this visit */
  }
}

export type Bounds = { x: number; y: number; width: number; height: number };

export class Settings {
  private data: SettingsData = read(KEY, DEFAULTS);
  private bounds: Record<string, Bounds> = read(BOUNDS_KEY, {});
  private listeners = new Set<() => void>();
  private media = typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: dark)') : null;

  constructor() {
    this.media?.addEventListener('change', () => this.data.appearance === 'auto' && this.notify());
  }

  get<K extends keyof SettingsData>(key: K): SettingsData[K] {
    return this.data[key];
  }

  set<K extends keyof SettingsData>(key: K, value: SettingsData[K]): void {
    this.data = { ...this.data, [key]: value };
    write(KEY, this.data);
    this.notify();
  }

  /** The appearance in effect ('auto' resolved against the system). */
  theme(): 'dark' | 'light' {
    const a = this.data.appearance;
    if (a === 'auto') return this.media?.matches === false ? 'light' : 'dark';
    return a;
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  boundsFor(appId: string): Bounds | undefined {
    return this.bounds[appId];
  }

  rememberBounds(appId: string, b: Bounds): void {
    this.bounds[appId] = b;
    write(BOUNDS_KEY, this.bounds);
  }

  resetLayout(): void {
    this.bounds = {};
    write(BOUNDS_KEY, {});
  }

  private notify(): void {
    for (const fn of this.listeners) fn();
  }
}

export const reducedMotion = (): boolean =>
  typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Phones and narrow windows: one full-screen window at a time. */
export const compactMode = (): boolean => window.innerWidth < 720;

// Original gradient wallpapers.
export const WALLPAPERS: { id: string; name: string; css: string; theme: 'dark' | 'light' }[] = [
  {
    id: 'lifo-night',
    name: 'Lifo Night',
    theme: 'dark',
    css: 'radial-gradient(120% 90% at 85% 110%, rgba(158,206,106,0.38) 0%, transparent 55%), radial-gradient(90% 70% at 10% 0%, rgba(122,162,247,0.35) 0%, transparent 60%), radial-gradient(70% 60% at 60% 40%, rgba(187,154,247,0.18) 0%, transparent 70%), linear-gradient(160deg, #0b0d1a 0%, #141729 55%, #0a0c14 100%)',
  },
  {
    id: 'horizon',
    name: 'Horizon',
    theme: 'dark',
    css: 'radial-gradient(160% 70% at 70% 118%, #ffc79a 0%, #ff6a4a 18%, #8b5cf6 34%, #3b5bff 46%, transparent 62%), radial-gradient(60% 40% at 20% 10%, rgba(59,91,255,0.25), transparent 70%), linear-gradient(180deg, #05060f 0%, #0b0c22 70%, #120d2a 100%)',
  },
  {
    id: 'lagoon',
    name: 'Lagoon',
    theme: 'dark',
    css: 'radial-gradient(100% 80% at 0% 100%, #0f766e 0%, transparent 60%), radial-gradient(90% 70% at 100% 0%, #1d4ed8 0%, transparent 60%), radial-gradient(60% 60% at 60% 60%, rgba(45,212,191,0.35), transparent 70%), linear-gradient(135deg, #042f2e, #0c1e3d)',
  },
  {
    id: 'dune',
    name: 'Dune',
    theme: 'light',
    css: 'radial-gradient(120% 80% at 20% 110%, #c2410c 0%, transparent 55%), radial-gradient(100% 70% at 90% 100%, #f59e0b 0%, transparent 60%), radial-gradient(80% 60% at 50% 0%, #fde68a 0%, transparent 70%), linear-gradient(180deg, #fff7ed, #fdba74)',
  },
  {
    id: 'meadow',
    name: 'Meadow',
    theme: 'light',
    css: 'radial-gradient(90% 70% at 10% 100%, #86efac 0%, transparent 60%), radial-gradient(80% 60% at 90% 10%, #93c5fd 0%, transparent 65%), radial-gradient(60% 50% at 50% 50%, #fef9c3, transparent 70%), linear-gradient(160deg, #ecfccb, #dbeafe)',
  },
  {
    id: 'graphite',
    name: 'Graphite',
    theme: 'dark',
    css: 'radial-gradient(100% 80% at 50% 120%, #3f3f46 0%, transparent 60%), radial-gradient(80% 60% at 0% 0%, #27272a 0%, transparent 70%), linear-gradient(180deg, #18181b, #09090b)',
  },
];

export function wallpaperCss(id: string): string {
  return (WALLPAPERS.find((w) => w.id === id) ?? WALLPAPERS[0]).css;
}
