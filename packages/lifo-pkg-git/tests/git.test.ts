import { describe, it, expect, beforeEach } from 'vitest';
import { VFS } from '@lifo-sh/core';
import type { CommandContext } from '@lifo-sh/core';
import gitCommand from '../src/index.js';

function makeCtx(vfs: VFS, args: string[], cwd = '/repo'): CommandContext & { out: string; err: string } {
  const result = {
    args,
    env: { USER: 'testuser', HOME: '/home/user', GIT_AUTHOR_NAME: 'Test User', GIT_AUTHOR_EMAIL: 'test@lifo.sh' },
    cwd,
    vfs,
    stdout: { write(text: string) { result.out += text; } },
    stderr: { write(text: string) { result.err += text; } },
    signal: new AbortController().signal,
    out: '',
    err: '',
  };
  return result;
}

describe('git', () => {
  let vfs: VFS;

  beforeEach(() => {
    vfs = new VFS();
    vfs.mkdir('/repo', { recursive: true });
    vfs.mkdir('/home/user', { recursive: true });
  });

  describe('help', () => {
    it('shows usage with --help', async () => {
      const ctx = makeCtx(vfs, ['--help']);
      const code = await gitCommand(ctx);
      expect(code).toBe(0);
      expect(ctx.out).toContain('usage: git');
    });

    it('shows usage with no args', async () => {
      const ctx = makeCtx(vfs, []);
      const code = await gitCommand(ctx);
      expect(code).toBe(1);
      expect(ctx.out).toContain('usage: git');
    });

    it('rejects unknown subcommand in a repo', async () => {
      // Init a repo first so we don't get "not a git repository" error
      await gitCommand(makeCtx(vfs, ['init']));
      const ctx = makeCtx(vfs, ['foobar']);
      const code = await gitCommand(ctx);
      expect(code).toBe(1);
      expect(ctx.err).toContain("'foobar' is not a git command");
    });
  });

  describe('init', () => {
    it('initializes a new repository in cwd', async () => {
      const ctx = makeCtx(vfs, ['init']);
      const code = await gitCommand(ctx);
      expect(code).toBe(0);
      expect(ctx.out).toContain('Initialized empty Git repository');
      expect(vfs.exists('/repo/.git')).toBe(true);
      expect(vfs.exists('/repo/.git/HEAD')).toBe(true);
    });

    it('initializes a new repository in specified dir', async () => {
      const ctx = makeCtx(vfs, ['init', 'myrepo']);
      const code = await gitCommand(ctx);
      expect(code).toBe(0);
      expect(vfs.exists('/repo/myrepo/.git/HEAD')).toBe(true);
    });
  });

  describe('add + commit + status + log', () => {
    beforeEach(async () => {
      await gitCommand(makeCtx(vfs, ['init']));
    });

    it('status shows untracked files', async () => {
      vfs.writeFile('/repo/readme.txt', 'hello');
      const ctx = makeCtx(vfs, ['status']);
      const code = await gitCommand(ctx);
      expect(code).toBe(0);
      expect(ctx.out).toContain('Untracked files');
      expect(ctx.out).toContain('readme.txt');
    });

    it('add stages a file and status shows staged', async () => {
      vfs.writeFile('/repo/readme.txt', 'hello');
      let ctx = makeCtx(vfs, ['add', 'readme.txt']);
      let code = await gitCommand(ctx);
      expect(code).toBe(0);

      ctx = makeCtx(vfs, ['status']);
      code = await gitCommand(ctx);
      expect(code).toBe(0);
      expect(ctx.out).toContain('Changes to be committed');
      expect(ctx.out).toContain('new file:   readme.txt');
    });

    it('commit creates a commit', async () => {
      vfs.writeFile('/repo/readme.txt', 'hello');
      await gitCommand(makeCtx(vfs, ['add', 'readme.txt']));

      const ctx = makeCtx(vfs, ['commit', '-m', 'initial commit']);
      const code = await gitCommand(ctx);
      expect(code).toBe(0);
      expect(ctx.out).toMatch(/\[[a-f0-9]{7}\] initial commit/);
    });

    it('log shows commits', async () => {
      vfs.writeFile('/repo/readme.txt', 'hello');
      await gitCommand(makeCtx(vfs, ['add', 'readme.txt']));
      await gitCommand(makeCtx(vfs, ['commit', '-m', 'initial commit']));

      const ctx = makeCtx(vfs, ['log']);
      const code = await gitCommand(ctx);
      expect(code).toBe(0);
      expect(ctx.out).toContain('initial commit');
      expect(ctx.out).toContain('Author: Test User');
    });

    it('log --oneline shows compact output', async () => {
      vfs.writeFile('/repo/readme.txt', 'hello');
      await gitCommand(makeCtx(vfs, ['add', 'readme.txt']));
      await gitCommand(makeCtx(vfs, ['commit', '-m', 'first commit']));

      const ctx = makeCtx(vfs, ['log', '--oneline']);
      const code = await gitCommand(ctx);
      expect(code).toBe(0);
      expect(ctx.out).toContain('first commit');
      expect(ctx.out).not.toContain('Author:');
    });

    it('status shows clean after commit', async () => {
      vfs.writeFile('/repo/readme.txt', 'hello');
      await gitCommand(makeCtx(vfs, ['add', 'readme.txt']));
      await gitCommand(makeCtx(vfs, ['commit', '-m', 'initial']));

      const ctx = makeCtx(vfs, ['status']);
      const code = await gitCommand(ctx);
      expect(code).toBe(0);
      expect(ctx.out).toContain('nothing to commit, working tree clean');
    });

    it('add . stages all files', async () => {
      vfs.writeFile('/repo/a.txt', 'aaa');
      vfs.writeFile('/repo/b.txt', 'bbb');
      let ctx = makeCtx(vfs, ['add', '.']);
      let code = await gitCommand(ctx);
      expect(code).toBe(0);

      ctx = makeCtx(vfs, ['status']);
      code = await gitCommand(ctx);
      expect(ctx.out).toContain('a.txt');
      expect(ctx.out).toContain('b.txt');
    });

    it('commit without -m flag errors', async () => {
      vfs.writeFile('/repo/readme.txt', 'hello');
      await gitCommand(makeCtx(vfs, ['add', 'readme.txt']));

      const ctx = makeCtx(vfs, ['commit']);
      const code = await gitCommand(ctx);
      expect(code).toBe(1);
      expect(ctx.err).toContain('requires a value');
    });
  });

  describe('branch', () => {
    beforeEach(async () => {
      await gitCommand(makeCtx(vfs, ['init']));
      vfs.writeFile('/repo/readme.txt', 'hello');
      await gitCommand(makeCtx(vfs, ['add', 'readme.txt']));
      await gitCommand(makeCtx(vfs, ['commit', '-m', 'initial']));
    });

    it('lists branches', async () => {
      const ctx = makeCtx(vfs, ['branch']);
      const code = await gitCommand(ctx);
      expect(code).toBe(0);
      expect(ctx.out).toContain('master');
    });

    it('creates a new branch', async () => {
      let ctx = makeCtx(vfs, ['branch', 'feature']);
      let code = await gitCommand(ctx);
      expect(code).toBe(0);

      ctx = makeCtx(vfs, ['branch']);
      code = await gitCommand(ctx);
      expect(ctx.out).toContain('feature');
      expect(ctx.out).toContain('master');
    });

    it('deletes a branch', async () => {
      await gitCommand(makeCtx(vfs, ['branch', 'feature']));

      const ctx = makeCtx(vfs, ['branch', '-d', 'feature']);
      const code = await gitCommand(ctx);
      expect(code).toBe(0);
      expect(ctx.out).toContain('Deleted branch feature');
    });
  });

  describe('checkout', () => {
    beforeEach(async () => {
      await gitCommand(makeCtx(vfs, ['init']));
      vfs.writeFile('/repo/readme.txt', 'hello');
      await gitCommand(makeCtx(vfs, ['add', 'readme.txt']));
      await gitCommand(makeCtx(vfs, ['commit', '-m', 'initial']));
    });

    it('switches branches', async () => {
      await gitCommand(makeCtx(vfs, ['branch', 'feature']));

      const ctx = makeCtx(vfs, ['checkout', 'feature']);
      const code = await gitCommand(ctx);
      expect(code).toBe(0);
      expect(ctx.out).toContain("Switched to branch 'feature'");
    });

    it('creates and switches with -b', async () => {
      const ctx = makeCtx(vfs, ['checkout', '-b', 'newbranch']);
      const code = await gitCommand(ctx);
      expect(code).toBe(0);
      expect(ctx.out).toContain("Switched to branch 'newbranch'");
    });

    it('errors without branch name', async () => {
      const ctx = makeCtx(vfs, ['checkout']);
      const code = await gitCommand(ctx);
      expect(code).toBe(1);
      expect(ctx.err).toContain('you must specify');
    });
  });

  describe('remote', () => {
    beforeEach(async () => {
      await gitCommand(makeCtx(vfs, ['init']));
    });

    it('adds a remote', async () => {
      let ctx = makeCtx(vfs, ['remote', 'add', 'origin', 'https://example.com/repo.git']);
      const code = await gitCommand(ctx);
      expect(code).toBe(0);

      ctx = makeCtx(vfs, ['remote', '-v']);
      await gitCommand(ctx);
      expect(ctx.out).toContain('origin');
      expect(ctx.out).toContain('https://example.com/repo.git');
    });

    it('lists remotes', async () => {
      await gitCommand(makeCtx(vfs, ['remote', 'add', 'origin', 'https://example.com/repo.git']));

      const ctx = makeCtx(vfs, ['remote']);
      const code = await gitCommand(ctx);
      expect(code).toBe(0);
      expect(ctx.out).toContain('origin');
    });

    it('removes a remote', async () => {
      await gitCommand(makeCtx(vfs, ['remote', 'add', 'origin', 'https://example.com/repo.git']));

      let ctx = makeCtx(vfs, ['remote', 'remove', 'origin']);
      const code = await gitCommand(ctx);
      expect(code).toBe(0);

      ctx = makeCtx(vfs, ['remote']);
      await gitCommand(ctx);
      expect(ctx.out).toBe('');
    });
  });

  describe('requires repo', () => {
    it('errors when not in a git repo', async () => {
      const ctx = makeCtx(vfs, ['status']);
      const code = await gitCommand(ctx);
      expect(code).toBe(128);
      expect(ctx.err).toContain('not a git repository');
    });
  });

  describe('diff', () => {
    beforeEach(async () => {
      await gitCommand(makeCtx(vfs, ['init']));
      vfs.writeFile('/repo/readme.txt', 'hello');
      await gitCommand(makeCtx(vfs, ['add', 'readme.txt']));
      await gitCommand(makeCtx(vfs, ['commit', '-m', 'initial']));
    });

    it('shows staged diff for new files', async () => {
      vfs.writeFile('/repo/new.txt', 'new content');
      await gitCommand(makeCtx(vfs, ['add', 'new.txt']));

      const ctx = makeCtx(vfs, ['diff', '--staged']);
      const code = await gitCommand(ctx);
      expect(code).toBe(0);
      expect(ctx.out).toContain('new.txt');
      expect(ctx.out).toContain('new file');
    });

    it('shows nothing when working tree is clean', async () => {
      const ctx = makeCtx(vfs, ['diff']);
      const code = await gitCommand(ctx);
      expect(code).toBe(0);
      expect(ctx.out).toBe('');
    });
  });

  describe('multi-file commit then status (simulates post-checkout)', () => {
    it('status is clean after committing multiple files', async () => {
      await gitCommand(makeCtx(vfs, ['init']));

      // Create several files to mimic a clone checkout
      vfs.writeFile('/repo/README.md', '# Hello World\n');
      vfs.writeFile('/repo/package.json', '{"name":"test","version":"1.0.0"}');
      vfs.mkdir('/repo/src');
      vfs.writeFile('/repo/src/index.ts', 'export default {};\n');

      await gitCommand(makeCtx(vfs, ['add', '.']));
      await gitCommand(makeCtx(vfs, ['commit', '-m', 'initial files']));

      const ctx = makeCtx(vfs, ['status']);
      const code = await gitCommand(ctx);
      expect(code).toBe(0);
      expect(ctx.out).toContain('nothing to commit, working tree clean');
      expect(ctx.out).not.toContain('modified');
      expect(ctx.out).not.toContain('new file');
    });

    it('status is clean after a second commit on a branch', async () => {
      await gitCommand(makeCtx(vfs, ['init']));

      vfs.writeFile('/repo/file1.txt', 'content1');
      await gitCommand(makeCtx(vfs, ['add', '.']));
      await gitCommand(makeCtx(vfs, ['commit', '-m', 'first']));

      // Create branch and switch
      await gitCommand(makeCtx(vfs, ['checkout', '-b', 'feature']));

      // Modify and add more files
      vfs.writeFile('/repo/file1.txt', 'modified content1');
      vfs.writeFile('/repo/file2.txt', 'content2');
      await gitCommand(makeCtx(vfs, ['add', '.']));
      await gitCommand(makeCtx(vfs, ['commit', '-m', 'feature work']));

      const ctx = makeCtx(vfs, ['status']);
      const code = await gitCommand(ctx);
      expect(code).toBe(0);
      expect(ctx.out).toContain('nothing to commit, working tree clean');
    });

    it('checkout to another branch shows clean status', async () => {
      await gitCommand(makeCtx(vfs, ['init']));

      vfs.writeFile('/repo/file.txt', 'original');
      await gitCommand(makeCtx(vfs, ['add', '.']));
      await gitCommand(makeCtx(vfs, ['commit', '-m', 'initial']));

      await gitCommand(makeCtx(vfs, ['checkout', '-b', 'other']));
      vfs.writeFile('/repo/file.txt', 'changed');
      await gitCommand(makeCtx(vfs, ['add', '.']));
      await gitCommand(makeCtx(vfs, ['commit', '-m', 'change on other']));

      // Switch back to master
      await gitCommand(makeCtx(vfs, ['checkout', 'master']));

      const ctx = makeCtx(vfs, ['status']);
      const code = await gitCommand(ctx);
      expect(code).toBe(0);
      expect(ctx.out).toContain('nothing to commit, working tree clean');
    });
  });

  describe('push', () => {
    beforeEach(async () => {
      await gitCommand(makeCtx(vfs, ['init']));
      vfs.writeFile('/repo/readme.txt', 'hello');
      await gitCommand(makeCtx(vfs, ['add', 'readme.txt']));
      await gitCommand(makeCtx(vfs, ['commit', '-m', 'initial']));
    });

    it('errors when no remote is configured', async () => {
      const ctx = makeCtx(vfs, ['push']);
      const code = await gitCommand(ctx);
      expect(code).toBe(128);
      expect(ctx.err).toContain('fatal');
    });

    it('errors with auth hint when pushing to a remote without credentials', async () => {
      await gitCommand(makeCtx(vfs, ['remote', 'add', 'origin', 'https://example.com/repo.git']));
      const ctx = makeCtx(vfs, ['push', 'origin', 'master']);
      const code = await gitCommand(ctx);
      // Will fail due to no actual server, but should attempt the push
      expect(code).toBe(128);
      expect(ctx.err).toContain('fatal');
    });

    it('push with -u flag does not crash', async () => {
      await gitCommand(makeCtx(vfs, ['remote', 'add', 'origin', 'https://example.com/repo.git']));
      const ctx = makeCtx(vfs, ['push', '-u', 'origin', 'master']);
      const code = await gitCommand(ctx);
      expect(code).toBe(128); // no real server
      expect(ctx.err).toContain('fatal');
    });
  });

  describe('pull', () => {
    beforeEach(async () => {
      await gitCommand(makeCtx(vfs, ['init']));
      vfs.writeFile('/repo/readme.txt', 'hello');
      await gitCommand(makeCtx(vfs, ['add', 'readme.txt']));
      await gitCommand(makeCtx(vfs, ['commit', '-m', 'initial']));
    });

    it('errors when no remote is configured', async () => {
      const ctx = makeCtx(vfs, ['pull']);
      const code = await gitCommand(ctx);
      expect(code).toBe(128);
      expect(ctx.err).toContain('fatal');
    });

    it('shows pulling message', async () => {
      await gitCommand(makeCtx(vfs, ['remote', 'add', 'origin', 'https://example.com/repo.git']));
      const ctx = makeCtx(vfs, ['pull', 'origin']);
      const code = await gitCommand(ctx);
      expect(code).toBe(128); // no real server
      expect(ctx.out).toContain('Pulling from origin');
    });
  });

  describe('fetch', () => {
    beforeEach(async () => {
      await gitCommand(makeCtx(vfs, ['init']));
      vfs.writeFile('/repo/readme.txt', 'hello');
      await gitCommand(makeCtx(vfs, ['add', 'readme.txt']));
      await gitCommand(makeCtx(vfs, ['commit', '-m', 'initial']));
    });

    it('shows fetching message', async () => {
      await gitCommand(makeCtx(vfs, ['remote', 'add', 'origin', 'https://example.com/repo.git']));
      const ctx = makeCtx(vfs, ['fetch', 'origin']);
      const code = await gitCommand(ctx);
      expect(code).toBe(128); // no real server
      expect(ctx.out).toContain('Fetching from origin');
    });

    it('defaults to origin remote', async () => {
      await gitCommand(makeCtx(vfs, ['remote', 'add', 'origin', 'https://example.com/repo.git']));
      const ctx = makeCtx(vfs, ['fetch']);
      const code = await gitCommand(ctx);
      expect(code).toBe(128); // no real server
      expect(ctx.out).toContain('Fetching from origin');
    });
  });

  describe('CORS proxy', () => {
    // Capture the URL git's HTTP client actually fetches, without a network.
    async function captureCloneFetch(env: Record<string, string>): Promise<string> {
      const calls: string[] = [];
      const realFetch = globalThis.fetch;
      globalThis.fetch = (async (input: unknown) => {
        calls.push(typeof input === 'string' ? input : (input as { url: string }).url);
        return new Response(new Uint8Array(), { status: 500 });
      }) as typeof fetch;
      try {
        const ctx = makeCtx(vfs, ['clone', 'https://github.com/foo/bar.git', '/out']);
        Object.assign(ctx.env, env);
        await gitCommand(ctx);
      } finally {
        globalThis.fetch = realFetch;
      }
      expect(calls.length).toBeGreaterThan(0);
      return calls[0];
    }

    it('routes remote requests through LIFO_GIT_CORS_PROXY when set', async () => {
      const first = await captureCloneFetch({ LIFO_GIT_CORS_PROXY: 'https://proxy.test' });
      // isomorphic-git corsProxy uses path format with the protocol stripped:
      // `${proxy}/${host}${path}` (which cors.isomorphic-git.org reconstructs).
      expect(first).toContain('https://proxy.test/github.com/foo/bar.git');
    });

    it('fetches directly when no proxy is set', async () => {
      const first = await captureCloneFetch({});
      expect(first).toContain('https://github.com/foo/bar.git');
      expect(first).not.toContain('proxy.test');
    });
  });
});
