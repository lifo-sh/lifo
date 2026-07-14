/**
 * JS shim for `@tailwindcss/oxide` — Tailwind v4's Rust class-name Scanner.
 *
 * The native binding is a `.node` and its wasm fallback is a threaded
 * (`wasm32-wasip1-threads`) build that needs SharedArrayBuffer → COOP/COEP,
 * which Lifo deliberately doesn't require. So we reimplement ONLY the Scanner
 * (the file → candidate extractor) in JS. Everything else in Tailwind v4
 * (`@tailwindcss/node` compile/optimize, Features) is already plain JS, and
 * `lightningcss` is stubbed elsewhere — so this is the single missing piece.
 *
 * `@tailwindcss/vite` uses `new Scanner({sources}).scan()` plus `.files` /
 * `.globs` (for watch). We walk each source base over the VFS, skip
 * node_modules / VCS / build dirs, read text files, and extract candidates with
 * a permissive tokenizer. Over-extraction is safe: Tailwind's compiler only
 * emits CSS for candidates that resolve to real utilities and ignores the rest.
 */

interface OxideVfs {
  exists(path: string): boolean;
  stat(path: string): { type: 'file' | 'directory' };
  readdir(path: string): Array<{ name: string }>;
  readFileString(path: string): string;
}

interface SourceEntry {
  base: string;
  pattern: string;
  negated: boolean;
}

// Directories Tailwind's scanner ignores by default (plus VCS/build output).
const SKIP_DIRS = new Set([
  'node_modules', '.git', '.hg', '.svn', 'dist', 'build', '.next', '.nuxt',
  '.output', '.vite', '.cache', '.turbo', 'coverage', '.svelte-kit', 'out',
]);

// Extensions worth scanning for class candidates (templates + source + docs).
const SCAN_EXT = new Set([
  'html', 'htm', 'js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs', 'mts', 'cts',
  'vue', 'svelte', 'astro', 'md', 'mdx', 'php', 'erb', 'twig', 'hbs',
  'handlebars', 'ejs', 'liquid', 'njk', 'json',
]);

// A candidate is a run of characters bounded by whitespace, quotes, angle
// brackets, `=`, or JS/JSX braces. Keeps `[]`/`()`/`:`/`/`/`.`/`-` etc. so
// variants (`hover:`), arbitrary values (`bg-[#fff]`, `grid-cols-[repeat(2,1fr)]`)
// and modifiers (`text-sm/6`) survive intact.
const TOKEN_RE = /[^\s"'`<>={}]+/g;

function extractCandidates(content: string, out: Set<string>): void {
  const matches = content.match(TOKEN_RE);
  if (!matches) return;
  for (const m of matches) out.add(m);
}

function join(dir: string, name: string): string {
  return dir.endsWith('/') ? dir + name : dir + '/' + name;
}

function extOf(name: string): string {
  const i = name.lastIndexOf('.');
  return i === -1 ? '' : name.slice(i + 1).toLowerCase();
}

export function createOxideScanner(vfs: OxideVfs) {
  class Scanner {
    private sources: SourceEntry[];
    private _files: string[] | null = null;

    constructor(opts?: { sources?: SourceEntry[] }) {
      this.sources = (opts?.sources ?? []).filter((s) => !s.negated);
    }

    private walk(dir: string, files: string[], seen: Set<string>): void {
      let entries: Array<{ name: string }>;
      try {
        entries = vfs.readdir(dir);
      } catch {
        return;
      }
      for (const e of entries) {
        const name = e.name;
        if (!name || name.startsWith('.')) continue; // skip dotfiles/dirs
        const full = join(dir, name);
        let type: 'file' | 'directory';
        try {
          type = vfs.stat(full).type;
        } catch {
          continue;
        }
        if (type === 'directory') {
          if (SKIP_DIRS.has(name)) continue;
          this.walk(full, files, seen);
        } else if (SCAN_EXT.has(extOf(name)) && !seen.has(full)) {
          seen.add(full);
          files.push(full);
        }
      }
    }

    private collectFiles(): string[] {
      const files: string[] = [];
      const seen = new Set<string>();
      for (const src of this.sources) {
        if (!src.base || !vfs.exists(src.base)) continue;
        this.walk(src.base, files, seen);
      }
      return files;
    }

    scan(): string[] {
      this._files = this.collectFiles();
      const candidates = new Set<string>();
      for (const file of this._files) {
        try {
          extractCandidates(vfs.readFileString(file), candidates);
        } catch {
          /* unreadable/binary — skip */
        }
      }
      return [...candidates];
    }

    scanFiles(input: Array<{ file?: string; content?: string; extension: string }>): string[] {
      const candidates = new Set<string>();
      for (const ch of input) {
        let content = ch.content ?? '';
        if (!content && ch.file) {
          try {
            content = vfs.readFileString(ch.file);
          } catch {
            content = '';
          }
        }
        extractCandidates(content, candidates);
      }
      return [...candidates];
    }

    getCandidatesWithPositions(
      input: { file?: string; content?: string; extension: string },
    ): Array<{ candidate: string; position: number }> {
      let content = input.content ?? '';
      if (!content && input.file) {
        try {
          content = vfs.readFileString(input.file);
        } catch {
          content = '';
        }
      }
      const out: Array<{ candidate: string; position: number }> = [];
      let m: RegExpExecArray | null;
      TOKEN_RE.lastIndex = 0;
      while ((m = TOKEN_RE.exec(content))) out.push({ candidate: m[0], position: m.index });
      return out;
    }

    get files(): string[] {
      return this._files ?? (this._files = this.collectFiles());
    }

    get globs(): Array<{ base: string; pattern: string }> {
      return this.sources.map((s) => ({ base: s.base, pattern: s.pattern }));
    }

    get normalizedSources(): Array<{ base: string; pattern: string }> {
      return this.globs;
    }
  }

  return Scanner;
}
