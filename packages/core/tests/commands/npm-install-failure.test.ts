import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { VFS } from '../../src/kernel/vfs/index.js';
import type { CommandContext } from '../../src/commands/types.js';
import { createNpmCommand } from '../../src/commands/system/npm.js';
import { CommandRegistry } from '../../src/commands/registry.js';

function createContext(vfs: VFS, args: string[], cwd: string) {
  const stdout = { text: '', write(t: string) { this.text += t; } };
  const stderr = { text: '', write(t: string) { this.text += t; } };
  const ctx: CommandContext & { stdout: typeof stdout; stderr: typeof stderr } = {
    args,
    env: { HOME: '/home/user', USER: 'user', HOSTNAME: 'lifo', NPM_REGISTRY: 'https://registry.test' },
    cwd,
    vfs,
    stdout,
    stderr,
    signal: new AbortController().signal,
  };
  return ctx;
}

describe('npm install failure exit codes', () => {
  let vfs: VFS;

  beforeEach(() => {
    vfs = new VFS();
    vfs.mkdir('/proj', { recursive: true });
    // A fake registry where every package is missing (HTTP 404).
    vi.stubGlobal('fetch', vi.fn(async () => new Response('not found', { status: 404, statusText: 'Not Found' })));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('exits non-zero when a package.json dependency cannot be resolved', async () => {
    vfs.writeFile('/proj/package.json', JSON.stringify({
      name: 'proj',
      version: '1.0.0',
      dependencies: { 'totally-not-a-real-package-xyzzy': '^1.0.0' },
    }));
    const npm = createNpmCommand(new CommandRegistry());
    const ctx = createContext(vfs, ['install'], '/proj');

    const code = await npm(ctx);

    expect(ctx.stderr.text).toContain('totally-not-a-real-package-xyzzy');
    expect(code).not.toBe(0);
  });

  it('exits non-zero when an explicit package cannot be installed', async () => {
    vfs.writeFile('/proj/package.json', JSON.stringify({ name: 'proj', version: '1.0.0' }));
    const npm = createNpmCommand(new CommandRegistry());
    const ctx = createContext(vfs, ['install', 'totally-not-a-real-package-xyzzy'], '/proj');

    const code = await npm(ctx);

    expect(code).not.toBe(0);
    // A failed install must not be recorded as a dependency.
    const pkg = JSON.parse(vfs.readFileString('/proj/package.json'));
    expect(pkg.dependencies?.['totally-not-a-real-package-xyzzy']).toBeUndefined();
  });
});
