// Original icons for Lifo Desktop: app tiles (64×64 rounded squares with a gradient and a glyph),
// file-type icons, and small stroke glyphs for toolbars and menus. No third-party artwork.

let gid = 0;
const uid = (p: string) => `${p}${++gid}`;

function tile(bg: [string, string], glyph: string, opts: { ring?: string } = {}): string {
  const id = uid('g');
  const hl = uid('h');
  return `<svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${bg[0]}"/><stop offset="1" stop-color="${bg[1]}"/></linearGradient>
    <linearGradient id="${hl}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity=".28"/><stop offset=".5" stop-color="#fff" stop-opacity="0"/></linearGradient>
  </defs>
  <rect x="3" y="3" width="58" height="58" rx="14" fill="url(#${id})"/>
  <rect x="3" y="3" width="58" height="58" rx="14" fill="url(#${hl})"/>
  <rect x="3.5" y="3.5" width="57" height="57" rx="13.5" fill="none" stroke="${opts.ring ?? 'rgba(255,255,255,.18)'}"/>
  ${glyph}
</svg>`;
}

export const APP_ICONS = {
  finder: tile(['#4f8cff', '#1d4fd8'], `
    <path d="M14 22a4 4 0 0 1 4-4h9l4 4h15a4 4 0 0 1 4 4v18a4 4 0 0 1-4 4H18a4 4 0 0 1-4-4z" fill="#fff" fill-opacity=".95"/>
    <path d="M14 27h36" stroke="#1d4fd8" stroke-opacity=".25" stroke-width="2"/>
    <path d="M22 35l5 4-5 4" fill="none" stroke="#1d4fd8" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/>
    <path d="M31 43h10" stroke="#1d4fd8" stroke-width="2.6" stroke-linecap="round"/>`),
  terminal: tile(['#2a2e45', '#0f111a'], `
    <path d="M17 24l9 8-9 8" fill="none" stroke="#9ece6a" stroke-width="4.5" stroke-linecap="round" stroke-linejoin="round"/>
    <rect x="30" y="37" width="16" height="5" rx="2" fill="#9ece6a"/>`, { ring: 'rgba(255,255,255,.12)' }),
  textedit: tile(['#fdfdfd', '#e6e6ea'], `
    <rect x="17" y="12" width="30" height="40" rx="3" fill="#fff" stroke="#c9c9d1"/>
    <path d="M22 21h20M22 27h20M22 33h14M22 39h17" stroke="#9aa0b4" stroke-width="2.2" stroke-linecap="round"/>
    <path d="M45 30l6-6 3 3-6 6-4 1z" fill="#f59e0b" stroke="#b45309" stroke-width="1"/>`, { ring: 'rgba(0,0,0,.12)' }),
  browser: tile(['#22d3ee', '#2563eb'], `
    <circle cx="32" cy="32" r="16" fill="none" stroke="#fff" stroke-width="3"/>
    <ellipse cx="32" cy="32" rx="7" ry="16" fill="none" stroke="#fff" stroke-width="2.4"/>
    <path d="M16 32h32M19 24h26M19 40h26" stroke="#fff" stroke-width="2.2"/>`),
  activity: tile(['#1f2937', '#030712'], `
    <rect x="12" y="16" width="40" height="32" rx="4" fill="#0b1220" stroke="#334155"/>
    <path d="M15 36h8l4-11 6 18 5-12 3 5h8" fill="none" stroke="#4ade80" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round"/>`),
  settings: tile(['#9ca3af', '#4b5563'], `
    <path d="M18 22h28M18 32h28M18 42h28" stroke="#f3f4f6" stroke-width="3" stroke-linecap="round"/>
    <circle cx="26" cy="22" r="4.5" fill="#374151" stroke="#f3f4f6" stroke-width="2.5"/>
    <circle cx="40" cy="32" r="4.5" fill="#374151" stroke="#f3f4f6" stroke-width="2.5"/>
    <circle cx="30" cy="42" r="4.5" fill="#374151" stroke="#f3f4f6" stroke-width="2.5"/>`),
  about: tile(['#1a1b26', '#0b0c14'], `
    <path d="M18 24l9 8-9 8" fill="none" stroke="#9ece6a" stroke-width="4.5" stroke-linecap="round" stroke-linejoin="round"/>
    <rect x="31" y="37" width="15" height="5" rx="2" fill="#9ece6a"/>`),
  preview: tile(['#f472b6', '#7c3aed'], `
    <rect x="15" y="17" width="34" height="30" rx="4" fill="#fff" fill-opacity=".95"/>
    <circle cx="25" cy="27" r="4" fill="#f59e0b"/>
    <path d="M17 45l11-11 7 7 5-5 9 9z" fill="#7c3aed" fill-opacity=".8"/>`),
};

export function trashIcon(full: boolean): string {
  return `<svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg">
  <defs><linearGradient id="tb" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#eef0f4" stop-opacity=".9"/><stop offset="1" stop-color="#b8bdc8" stop-opacity=".85"/></linearGradient></defs>
  ${full ? '<path d="M20 15c6-6 18-5 24 1l-3 4H22z" fill="#fff" stroke="#9aa0ad"/><path d="M24 13l8-4 9 5" fill="none" stroke="#9aa0ad"/>' : ''}
  <path d="M15 16h34l-3 40a4 4 0 0 1-4 4H22a4 4 0 0 1-4-4z" fill="url(#tb)" stroke="rgba(255,255,255,.7)"/>
  <ellipse cx="32" cy="16" rx="17" ry="3" fill="#dfe2e8" stroke="#a5abb7"/>
  <path d="M24 24l1.5 30M32 24v30M40 24l-1.5 30" stroke="#8b919e" stroke-width="1.6" stroke-linecap="round"/>
</svg>`;
}

export const FOLDER_ICON = `<svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg">
  <defs><linearGradient id="fb" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#7cb7ff"/><stop offset="1" stop-color="#3b82f6"/></linearGradient></defs>
  <path d="M6 16a4 4 0 0 1 4-4h14l5 5h25a4 4 0 0 1 4 4v4H6z" fill="#5a9cf5"/>
  <path d="M6 22a3 3 0 0 1 3-3h46a3 3 0 0 1 3 3v28a4 4 0 0 1-4 4H10a4 4 0 0 1-4-4z" fill="url(#fb)"/>
  <path d="M6 23h52" stroke="#fff" stroke-opacity=".35"/>
</svg>`;

export const DISK_ICON = `<svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg">
  <defs><linearGradient id="dk" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#e5e7eb"/><stop offset="1" stop-color="#9ca3af"/></linearGradient></defs>
  <rect x="6" y="20" width="52" height="26" rx="5" fill="url(#dk)" stroke="#6b7280"/>
  <rect x="10" y="38" width="44" height="4" rx="2" fill="#6b7280" fill-opacity=".35"/>
  <circle cx="50" cy="28" r="2" fill="#22c55e"/>
  <path d="M14 26l4 3-4 3" fill="none" stroke="#1a1b26" stroke-width="2" stroke-linecap="round"/>
</svg>`;

const FILE_COLORS: Record<string, string> = {
  js: '#eab308', mjs: '#eab308', cjs: '#eab308', ts: '#3b82f6', tsx: '#3b82f6', jsx: '#06b6d4',
  json: '#a3a3a3', md: '#8b5cf6', txt: '#9ca3af', html: '#f97316', css: '#0ea5e9', py: '#22c55e',
  sh: '#10b981', png: '#ec4899', jpg: '#ec4899', jpeg: '#ec4899', gif: '#ec4899', svg: '#f43f5e',
  gz: '#78716c', tar: '#78716c', zip: '#78716c', lock: '#78716c',
};

export function fileIcon(name: string): string {
  const ext = name.includes('.') ? name.split('.').pop()!.toLowerCase() : '';
  const color = FILE_COLORS[ext] ?? '#9ca3af';
  const label = ext.slice(0, 4).toUpperCase();
  return `<svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg">
  <path d="M14 6h25l13 13v37a3 3 0 0 1-3 3H14a3 3 0 0 1-3-3V9a3 3 0 0 1 3-3z" fill="#fafafa" stroke="#c4c4cc"/>
  <path d="M39 6v10a3 3 0 0 0 3 3h10" fill="#e4e4ea" stroke="#c4c4cc"/>
  ${label ? `<rect x="11" y="38" width="${Math.max(22, label.length * 9 + 8)}" height="13" rx="3" fill="${color}"/><text x="${11 + Math.max(22, label.length * 9 + 8) / 2}" y="48" font-family="system-ui, sans-serif" font-size="9" font-weight="700" fill="#fff" text-anchor="middle">${label}</text>` : '<path d="M19 26h26M19 32h26M19 38h18" stroke="#c4c4cc" stroke-width="2" stroke-linecap="round"/>'}
</svg>`;
}

/** The Lifo mark as a menu-bar glyph: a prompt chevron and cursor, in currentColor. */
export const LIFO_MARK = `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M5 7l5 5-5 5" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/><rect x="12" y="15" width="8" height="3" rx="1.2" fill="currentColor"/></svg>`;

// Small stroke glyphs (24×24, currentColor).
const g = (d: string, extra = '') =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg">${d}${extra}</svg>`;

export const GLYPHS = {
  back: g('<path d="M15 18l-6-6 6-6"/>'),
  forward: g('<path d="M9 18l6-6-6-6"/>'),
  reload: g('<path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/>'),
  grid: g('<rect x="4" y="4" width="6" height="6" rx="1"/><rect x="14" y="4" width="6" height="6" rx="1"/><rect x="4" y="14" width="6" height="6" rx="1"/><rect x="14" y="14" width="6" height="6" rx="1"/>'),
  list: g('<path d="M8 6h13M8 12h13M8 18h13"/><circle cx="4" cy="6" r="1"/><circle cx="4" cy="12" r="1"/><circle cx="4" cy="18" r="1"/>'),
  search: g('<circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/>'),
  plus: g('<path d="M12 5v14M5 12h14"/>'),
  folderPlus: g('<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M12 10v6M9 13h6"/>'),
  folder: g('<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>'),
  home: g('<path d="M3 11l9-7 9 7"/><path d="M5 10v10h14V10"/>'),
  desktop: g('<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>'),
  doc: g('<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4"/>'),
  download: g('<path d="M12 4v11M7 10l5 5 5-5"/><path d="M5 20h14"/>'),
  code: g('<path d="M8 8l-4 4 4 4M16 8l4 4-4 4"/>'),
  drive: g('<rect x="3" y="7" width="18" height="10" rx="2"/><circle cx="17" cy="12" r="1"/>'),
  clock: g('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>'),
  trash: g('<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/>'),
  server: g('<rect x="3" y="4" width="18" height="7" rx="2"/><rect x="3" y="13" width="18" height="7" rx="2"/><path d="M7 7.5h.01M7 16.5h.01"/>'),
  globe: g('<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>'),
  terminal: g('<path d="M5 8l4 4-4 4M12 16h7"/>'),
  sun: g('<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>'),
  moon: g('<path d="M21 13A9 9 0 1 1 11 3a7 7 0 0 0 10 10z"/>'),
  network: g('<path d="M5 12.5a10 10 0 0 1 14 0M8.5 16a5 5 0 0 1 7 0"/><circle cx="12" cy="19.5" r="1"/><path d="M1.5 9a15 15 0 0 1 21 0"/>'),
  x: g('<path d="M6 6l12 12M18 6L6 18"/>'),
  stop: g('<circle cx="12" cy="12" r="9"/><path d="M9 9l6 6M15 9l-6 6"/>'),
  info: g('<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5h.01"/>'),
  palette: g('<circle cx="12" cy="12" r="9"/><circle cx="8" cy="10" r="1.3"/><circle cx="12" cy="7.5" r="1.3"/><circle cx="16" cy="10" r="1.3"/><path d="M12 21a3 3 0 0 1 0-6h2"/>'),
  image: g('<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="2"/><path d="M21 17l-5-5-9 8"/>'),
  dock: g('<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M6 16h12"/>'),
  keyboard: g('<rect x="2" y="6" width="20" height="12" rx="2"/><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10"/>'),
  cpu: g('<rect x="6" y="6" width="12" height="12" rx="2"/><path d="M9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4"/>'),
  memory: g('<rect x="3" y="7" width="18" height="10" rx="1"/><path d="M7 7v10M11 7v10M15 7v10M3 17l-1 3M21 17l1 3"/>'),
  missionControl: g('<rect x="3" y="4" width="8" height="7" rx="1"/><rect x="13" y="4" width="8" height="7" rx="1"/><rect x="3" y="13" width="8" height="7" rx="1"/><rect x="13" y="13" width="8" height="7" rx="1"/>'),
  save: g('<path d="M5 3h11l3 3v15H5z"/><path d="M8 3v5h7V3M8 21v-7h8v7"/>'),
  open: g('<path d="M4 20V5a2 2 0 0 1 2-2h5l2 2h5a2 2 0 0 1 2 2v2"/><path d="M4 20l3-9h15l-3 9z"/>'),
  minusSm: g('<path d="M6 12h12"/>'),
  play: g('<path d="M7 4l12 8-12 8z"/>'),
};
