import { describe, it, expect, beforeEach } from 'vitest';
import { VFS } from '../../src/kernel/vfs/index.js';
import type { CommandContext, CommandOutputStream } from '../../src/commands/types.js';
import grep from '../../src/commands/text/grep.js';

function createContext(
  vfs: VFS,
  args: string[],
  cwd = '/project'
): CommandContext & { stdout: CommandOutputStream & { text: string }; stderr: CommandOutputStream & { text: string } } {
  const stdout = { text: '', write(t: string) { this.text += t; } };
  const stderr = { text: '', write(t: string) { this.text += t; } };
  return {
    args,
    env: { HOME: '/home/user', USER: 'user' },
    cwd,
    vfs,
    stdout,
    stderr,
    signal: new AbortController().signal,
  } as any;
}

async function run(vfs: VFS, args: string[]) {
  const ctx = createContext(vfs, args);
  const code = await grep(ctx);
  return { code, stdout: ctx.stdout.text, stderr: ctx.stderr.text };
}

describe('grep long options', () => {
  let vfs: VFS;

  beforeEach(() => {
    vfs = new VFS();
    vfs.mkdir('/project', { recursive: true });
    vfs.mkdir('/project/src', { recursive: true });
    vfs.mkdir('/project/node_modules/dep', { recursive: true });
    vfs.writeFile('/project/src/a.ts', 'const needle = 1;\n');
    vfs.writeFile('/project/src/b.tsx', 'const needle = 2;\n');
    vfs.writeFile('/project/src/c.md', 'needle in prose\n');
    vfs.writeFile('/project/node_modules/dep/index.js', 'needle in a dependency\n');
  });

  describe('--include', () => {
    it('restricts the search to matching basenames', async () => {
      const { code, stdout } = await run(vfs, ['-rn', '--include=*.ts', 'needle', 'src']);
      expect(code).toBe(0);
      expect(stdout).toContain('a.ts');
      expect(stdout).not.toContain('b.tsx');
      expect(stdout).not.toContain('c.md');
    });

    it('accepts a separate argument as well as --include=GLOB', async () => {
      const { stdout } = await run(vfs, ['-rl', '--include', '*.tsx', 'needle', 'src']);
      expect(stdout.trim()).toBe('/project/src/b.tsx');
    });

    it('unions multiple --include globs', async () => {
      const { stdout } = await run(vfs, ['-rl', '--include=*.ts', '--include=*.tsx', 'needle', 'src']);
      expect(stdout).toContain('a.ts');
      expect(stdout).toContain('b.tsx');
      expect(stdout).not.toContain('c.md');
    });

    // The bug this file exists for: the option was parsed as a file operand, so grep reported
    // "no such file or directory" on stderr, searched everything anyway, and still exited 0.
    it('is not treated as a file operand', async () => {
      const { stderr } = await run(vfs, ['-rn', '--include=*.ts', 'needle', 'src']);
      expect(stderr).toBe('');
    });
  });

  describe('--exclude and --exclude-dir', () => {
    it('--exclude drops matching basenames', async () => {
      const { stdout } = await run(vfs, ['-rl', '--exclude=*.md', 'needle', 'src']);
      expect(stdout).not.toContain('c.md');
      expect(stdout).toContain('a.ts');
    });

    it('--exclude-dir prunes the directory', async () => {
      const { stdout } = await run(vfs, ['-rl', '--exclude-dir=node_modules', 'needle', '.']);
      expect(stdout).not.toContain('node_modules');
      expect(stdout).toContain('src/a.ts');
    });

    it('--exclude-dir tolerates a trailing slash', async () => {
      const { stdout } = await run(vfs, ['-rl', '--exclude-dir=node_modules/', 'needle', '.']);
      expect(stdout).not.toContain('node_modules');
    });

    it('--exclude wins over --include', async () => {
      const { stdout } = await run(vfs, ['-rl', '--include=*.ts', '--exclude=a.ts', 'needle', 'src']);
      expect(stdout.trim()).toBe('');
    });
  });

  describe('long aliases', () => {
    it('--ignore-case behaves like -i', async () => {
      vfs.writeFile('/project/src/upper.ts', 'NEEDLE\n');
      const { stdout } = await run(vfs, ['-rl', '--ignore-case', 'needle', 'src']);
      expect(stdout).toContain('upper.ts');
    });

    it('--line-number behaves like -n', async () => {
      const { stdout } = await run(vfs, ['--line-number', 'needle', 'src/a.ts']);
      expect(stdout.trim()).toBe('1:const needle = 1;');
    });

    it('--recursive behaves like -r', async () => {
      const { code } = await run(vfs, ['--recursive', '--files-with-matches', 'needle', 'src']);
      expect(code).toBe(0);
    });

    it('-R is accepted as -r', async () => {
      const { stdout } = await run(vfs, ['-Rl', 'needle', 'src']);
      expect(stdout).toContain('a.ts');
    });
  });

  describe('unknown options', () => {
    // Failing loudly beats searching the wrong file set and reporting success.
    it('exits 2 with a message', async () => {
      const { code, stderr } = await run(vfs, ['-rn', '--no-such-option', 'needle', 'src']);
      expect(code).toBe(2);
      expect(stderr).toContain("unrecognized option '--no-such-option'");
    });
  });

  describe('unchanged behaviour', () => {
    it('still exits 1 when nothing matches', async () => {
      const { code, stdout } = await run(vfs, ['-rn', 'absent-pattern', 'src']);
      expect(code).toBe(1);
      expect(stdout).toBe('');
    });

    it('still treats -- as end of options', async () => {
      vfs.writeFile('/project/src/dash.ts', '--include\n');
      const { stdout } = await run(vfs, ['--', '--include', 'src/dash.ts']);
      expect(stdout.trim()).toBe('--include');
    });
  });
});
