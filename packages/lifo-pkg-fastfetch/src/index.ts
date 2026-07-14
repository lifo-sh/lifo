import type { Command, VFS } from '@lifo-sh/core';

// ─── ANSI helpers ───

const ESC = '\x1b[';
const RST = `${ESC}0m`;
const BOLD = `${ESC}1m`;

function fg(code: number): string { return `${ESC}38;5;${code}m`; }
function bg(code: number): string { return `${ESC}48;5;${code}m`; }
function rgb(r: number, g: number, b: number): string { return `${ESC}38;2;${r};${g};${b}m`; }

// Named colors for config
const COLOR_MAP: Record<string, string> = {
  black: fg(0), red: fg(1), green: fg(2), yellow: fg(3),
  blue: fg(4), magenta: fg(5), cyan: fg(6), white: fg(7),
  brightblack: fg(8), brightred: fg(9), brightgreen: fg(10),
  brightyellow: fg(11), brightblue: fg(12), brightmagenta: fg(13),
  brightcyan: fg(14), brightwhite: fg(15),
};

function resolveColor(name: string): string {
  if (COLOR_MAP[name]) return COLOR_MAP[name];
  // Support "38;5;N" or "N" for 256-color
  const n = parseInt(name, 10);
  if (!isNaN(n) && n >= 0 && n <= 255) return fg(n);
  return fg(14); // default bright cyan
}

// ─── Logos ───

interface Logo {
  lines: string[];
  width: number;
}

function buildDefaultLogo(accent: string): Logo {
  const a = accent;
  const c1 = rgb(80, 200, 255);   // bright cyan
  const c2 = rgb(60, 160, 240);   // mid blue
  const c3 = rgb(100, 120, 255);  // blue-purple
  const c4 = rgb(160, 100, 255);  // purple
  const d = fg(8);                 // dim

  const lines = [
    `${a}          ▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄${RST}`,
    `${a}       ▄██${c1}▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀${a}██▄${RST}`,
    `${a}     ▄██${c1}▀                     ${a}██▄${RST}`,
    `${a}    ██${c1}▀  ${c1}██      ▀  ████  ████  ${a}██${RST}`,
    `${a}    ██${c2}   ${c2}██      █  █▀    █  █  ${a}██${RST}`,
    `${a}    ██${c3}   ${c3}██      █  ███   █  █  ${a}██${RST}`,
    `${a}    ██${c3}   ${c3}██      █  █▄    █  █  ${a}██${RST}`,
    `${a}    ██${c4}   ${c4}██████  █  ██    ████  ${a}██${RST}`,
    `${a}     ▀██${c4}▄                     ${a}██▀${RST}`,
    `${a}       ▀██${c4}▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄${a}██▀${RST}`,
    `${a}          ▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀${RST}`,
    `${d}            the browser is the${RST}`,
    `${d}                  kernel${RST}`,
  ];
  return { lines, width: 38 };
}

function buildSmallLogo(accent: string): Logo {
  const a = accent;
  const lines = [
    `${a}   ▗▖    ▀  ▗▀▀  ▗▀▀▖${RST}`,
    `${a}   ▐▌    █  ▐▀   ▐  ▐${RST}`,
    `${a}   ▐▙▄▖  █  ▐    ▝▀▀▘${RST}`,
  ];
  return { lines, width: 24 };
}

function buildNoneLogo(): Logo {
  return { lines: [], width: 0 };
}

function buildCustomLogo(raw: string, accent: string): Logo {
  const lines = raw.split('\n').map(l => `${accent}${l}${RST}`);
  let maxWidth = 0;
  for (const l of raw.split('\n')) {
    if (l.length > maxWidth) maxWidth = l.length;
  }
  return { lines, width: maxWidth + 2 };
}

// ─── Config ───

interface FetchConfig {
  logo: 'default' | 'small' | 'none' | string;
  color: string;
  separator: string;
  modules: string[];
}

const DEFAULT_CONFIG: FetchConfig = {
  logo: 'default',
  color: 'brightcyan',
  separator: '',
  modules: [
    'title', 'separator', 'os', 'host', 'kernel', 'uptime',
    'packages', 'shell', 'terminal', 'cpu', 'memory', 'disk',
    'locale', 'break', 'colors',
  ],
};

function loadConfig(vfs: VFS): FetchConfig {
  const paths = [
    '/home/user/.config/fastfetch/config.json',
    '/home/user/.fastfetchrc',
  ];
  for (const p of paths) {
    try {
      const raw = vfs.readFileString(p);
      const parsed = JSON.parse(raw);
      return {
        logo: parsed.logo ?? DEFAULT_CONFIG.logo,
        color: parsed.color ?? DEFAULT_CONFIG.color,
        separator: parsed.separator ?? DEFAULT_CONFIG.separator,
        modules: Array.isArray(parsed.modules) ? parsed.modules : DEFAULT_CONFIG.modules,
      };
    } catch { /* not found or invalid, try next */ }
  }
  return DEFAULT_CONFIG;
}

// ─── System info gathering ───

function formatUptime(): string {
  const ms = performance.now();
  const totalSeconds = Math.floor(ms / 1000);
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const mins = Math.floor((totalSeconds % 3600) / 60);
  const parts: string[] = [];
  if (days > 0) parts.push(`${days} day${days !== 1 ? 's' : ''}`);
  if (hours > 0) parts.push(`${hours} hour${hours !== 1 ? 's' : ''}`);
  parts.push(`${mins} min${mins !== 1 ? 's' : ''}`);
  return parts.join(', ');
}

function humanSize(bytes: number): string {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KiB';
  if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MiB';
  return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GiB';
}

function getMemoryInfo(): string {
  const perf = performance as unknown as {
    memory?: { jsHeapSizeLimit: number; usedJSHeapSize: number };
  };
  if (perf.memory) {
    const used = perf.memory.usedJSHeapSize;
    const total = perf.memory.jsHeapSizeLimit;
    const pct = Math.round((used / total) * 100);
    return `${humanSize(used)} / ${humanSize(total)} (${pct}%)`;
  }
  return 'N/A';
}

function getDiskInfo(vfs: VFS): string {
  let totalBytes = 0;
  let totalFiles = 0;
  function walk(dir: string): void {
    try {
      for (const entry of vfs.readdir(dir)) {
        const full = dir === '/' ? '/' + entry.name : dir + '/' + entry.name;
        if (entry.type === 'file') {
          totalFiles++;
          totalBytes += vfs.stat(full).size;
        } else {
          walk(full);
        }
      }
    } catch { /* skip */ }
  }
  walk('/');
  const totalSpace = 256 * 1024 * 1024;
  return `${humanSize(totalBytes)} / ${humanSize(totalSpace)} (${totalFiles} files)`;
}

function getBrowser(): string {
  if (typeof navigator === 'undefined') return 'Unknown';
  const ua = navigator.userAgent;
  if (ua.includes('Firefox/')) {
    const m = ua.match(/Firefox\/([\d.]+)/);
    return m ? `Firefox ${m[1]}` : 'Firefox';
  }
  if (ua.includes('Edg/')) {
    const m = ua.match(/Edg\/([\d.]+)/);
    return m ? `Edge ${m[1]}` : 'Edge';
  }
  if (ua.includes('Chrome/')) {
    const m = ua.match(/Chrome\/([\d.]+)/);
    return m ? `Chrome ${m[1]}` : 'Chrome';
  }
  if (ua.includes('Safari/')) {
    const m = ua.match(/Version\/([\d.]+)/);
    return m ? `Safari ${m[1]}` : 'Safari';
  }
  return 'Unknown';
}

function getPlatform(): string {
  if (typeof navigator === 'undefined') return 'Unknown';
  const ua = navigator.userAgent;
  if (ua.includes('Mac OS X')) {
    const m = ua.match(/Mac OS X ([\d_]+)/);
    return m ? `macOS ${m[1].replace(/_/g, '.')}` : 'macOS';
  }
  if (ua.includes('Windows NT')) {
    const m = ua.match(/Windows NT ([\d.]+)/);
    const ver = m ? m[1] : '';
    if (ver === '10.0') return 'Windows 10+';
    return `Windows NT ${ver}`;
  }
  if (ua.includes('Linux')) return 'Linux';
  if (ua.includes('Android')) return 'Android';
  if (ua.includes('iPhone') || ua.includes('iPad')) return 'iOS';
  return 'Unknown';
}

function getCPU(): string {
  if (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) {
    return `${navigator.hardwareConcurrency} cores`;
  }
  return 'N/A';
}

function getLocale(): string {
  if (typeof navigator !== 'undefined' && navigator.language) {
    return navigator.language;
  }
  return 'en-US';
}

function getBinCount(vfs: VFS): number {
  try {
    return vfs.readdir('/bin').length + 20;
  } catch {
    return 80;
  }
}

// ─── Color palette ───

function colorBlocks(): [string, string] {
  let normal = '';
  let bright = '';
  for (let i = 0; i < 8; i++) normal += `${bg(i)}   ${RST}`;
  for (let i = 8; i < 16; i++) bright += `${bg(i)}   ${RST}`;
  return [normal, bright];
}

// ─── Module resolver ───

function resolveModule(
  mod: string,
  ctx: { user: string; hostname: string; cols: number; rows: number; vfs: VFS },
  labelColor: string,
  separator: string,
): string | null {
  const lbl = (s: string, width: number) =>
    `${BOLD}${labelColor}${s.padEnd(width)}${RST}${separator}`;

  const W = 10; // label width

  switch (mod) {
    case 'title':
      return `${BOLD}${labelColor}${ctx.user}${RST}@${BOLD}${labelColor}${ctx.hostname}${RST}`;
    case 'separator':
      return `${fg(8)}${'\u2500'.repeat(ctx.user.length + 1 + ctx.hostname.length)}${RST}`;
    case 'os':
      return `${lbl('OS', W)}Lifo 1.0.0 (wasm)`;
    case 'host':
      return `${lbl('Host', W)}${getBrowser()} on ${getPlatform()}`;
    case 'kernel':
      return `${lbl('Kernel', W)}Lifo vfs+shell 1.0.0`;
    case 'uptime':
      return `${lbl('Uptime', W)}${formatUptime()}`;
    case 'packages':
      return `${lbl('Packages', W)}${getBinCount(ctx.vfs)} (builtins + commands)`;
    case 'shell':
      return `${lbl('Shell', W)}lifo-sh`;
    case 'terminal':
      return `${lbl('Terminal', W)}xterm.js (${ctx.cols}x${ctx.rows})`;
    case 'cpu':
      return `${lbl('CPU', W)}${getCPU()}`;
    case 'memory':
      return `${lbl('Memory', W)}${getMemoryInfo()}`;
    case 'disk': {
      return `${lbl('Disk (/)', W)}${getDiskInfo(ctx.vfs)}`;
    }
    case 'locale':
      return `${lbl('Locale', W)}${getLocale()}`;
    case 'colors': {
      const [n, b] = colorBlocks();
      return n + '\n' + b;
    }
    case 'break':
      return '';
    default:
      return null;
  }
}

// ─── Main command ───

const command: Command = async (ctx) => {
  const config = loadConfig(ctx.vfs);

  // Handle --help
  if (ctx.args.includes('--help') || ctx.args.includes('-h')) {
    ctx.stdout.write(`Usage: fastfetch [--logo default|small|none] [--color COLOR]

Config file: ~/.config/fastfetch/config.json

Example config:
{
  "logo": "default",
  "color": "brightcyan",
  "separator": "",
  "modules": [
    "title", "separator", "os", "host", "kernel",
    "uptime", "packages", "shell", "terminal",
    "cpu", "memory", "disk", "locale",
    "break", "colors"
  ]
}

Available modules:
  title, separator, os, host, kernel, uptime, packages,
  shell, terminal, cpu, memory, disk, locale, colors, break

Available logos: default, small, none (or put custom ASCII in config)

Colors: black, red, green, yellow, blue, magenta, cyan, white,
        brightblack, brightred, brightgreen, brightyellow,
        brightblue, brightmagenta, brightcyan, brightwhite,
        or a number 0-255 for 256-color palette
`);
    return 0;
  }

  // CLI overrides
  let logoChoice = config.logo;
  let colorChoice = config.color;

  for (let i = 0; i < ctx.args.length; i++) {
    if ((ctx.args[i] === '--logo' || ctx.args[i] === '-l') && i + 1 < ctx.args.length) {
      logoChoice = ctx.args[++i];
    }
    if ((ctx.args[i] === '--color' || ctx.args[i] === '-c') && i + 1 < ctx.args.length) {
      colorChoice = ctx.args[++i];
    }
  }

  const isKnownColor = COLOR_MAP[colorChoice] !== undefined ||
    (!isNaN(parseInt(colorChoice, 10)) && parseInt(colorChoice, 10) >= 0 && parseInt(colorChoice, 10) <= 255);
  if (!isKnownColor) {
    ctx.stderr.write(`fastfetch: unknown color '${colorChoice}', using default (brightcyan)\n`);
  }
  const accent = resolveColor(colorChoice);

  // Build logo
  let logo: Logo;
  if (logoChoice === 'default') {
    logo = buildDefaultLogo(accent);
  } else if (logoChoice === 'small') {
    logo = buildSmallLogo(accent);
  } else if (logoChoice === 'none') {
    logo = buildNoneLogo();
  } else {
    // Try loading custom logo from file
    try {
      const raw = ctx.vfs.readFileString(logoChoice);
      logo = buildCustomLogo(raw, accent);
    } catch {
      logo = buildDefaultLogo(accent);
    }
  }

  // Build info lines
  const user = ctx.env.USER || 'user';
  const hostname = ctx.env.HOSTNAME || 'lifo';
  const cols = parseInt(ctx.env['COLUMNS'] || '80', 10);
  const rows = parseInt(ctx.env['LINES'] || '24', 10);
  const modCtx = { user, hostname, cols, rows, vfs: ctx.vfs };

  const infoLines: string[] = [];
  for (const mod of config.modules) {
    const result = resolveModule(mod, modCtx, accent, config.separator);
    if (result !== null) {
      // Some modules (like colors) produce multi-line output
      for (const line of result.split('\n')) {
        infoLines.push(line);
      }
    }
  }

  // Render side by side
  const maxLines = Math.max(logo.lines.length, infoLines.length);
  let output = '\n';
  const gap = '  ';

  for (let i = 0; i < maxLines; i++) {
    const logoLine = i < logo.lines.length ? logo.lines[i] : '';
    const infoLine = i < infoLines.length ? infoLines[i] : '';

    if (logo.width > 0) {
      if (i < logo.lines.length) {
        output += logoLine + gap + infoLine + '\n';
      } else {
        output += ' '.repeat(logo.width) + gap + infoLine + '\n';
      }
    } else {
      output += infoLine + '\n';
    }
  }

  output += '\n';
  ctx.stdout.write(output);

  return 0;
};

export default command;
