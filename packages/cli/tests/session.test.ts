import { describe, it, expect, afterEach } from 'vitest';
import { startSession, type Session } from './helpers/session.js';

/**
 * Smoke tests for a real session, spawned the way a user invokes it.
 *
 * These exist because two bugs shipped in the CLI that no test could have caught,
 * since the package had no tests at all:
 *
 *   1. `new Shell(...)` was called with 4 arguments but needs 5 — so every
 *      detached session died at `shell.start()` with
 *      "Cannot read properties of undefined (reading 'spawn')".
 *   2. `ps`/`top`/`kill` were handed `shell.getJobTable()` where a
 *      `ProcessRegistry` was expected, so they threw
 *      "processRegistry.getAll is not a function".
 *
 * Neither is subtle. Both survived because nothing ever booted the thing.
 */
describe('lifo session', () => {
  let session: Session | undefined;

  afterEach(async () => {
    await session?.stop();
    session = undefined;
  });

  // Regression for bug 1. The daemon used to write its session file and then
  // crash, so "the socket exists" is not enough — it has to still be running.
  it('boots and stays alive, with nothing thrown on startup', async () => {
    session = await startSession();
    await new Promise((r) => setTimeout(r, 2000));

    expect(session.alive()).toBe(true);
    const output = session.stderr();
    expect(output).not.toMatch(/TypeError/);
    expect(output).not.toMatch(/Cannot read properties of undefined/);
  });

  it('runs a command and returns its output', async () => {
    session = await startSession();
    const out = await session.run('echo hello-from-the-box');
    expect(out).toContain('hello-from-the-box');
  });

  // Regression for bug 2.
  it('ps lists the shell process', async () => {
    session = await startSession();
    const out = await session.run('ps');
    expect(out).not.toMatch(/is not a function/);
    expect(out).toMatch(/PID/);
    expect(out).toMatch(/shell/);
  });

  it('top and kill do not throw either', async () => {
    session = await startSession();
    const top = await session.run('top');
    expect(top).not.toMatch(/is not a function/);
    // Killing PID 1 (the shell) is refused rather than crashing the box.
    const kill = await session.run('kill 1');
    expect(kill).not.toMatch(/is not a function/);
    expect(session.alive()).toBe(true);
  });

  it('mounts the host directory at /mnt/host', async () => {
    session = await startSession();
    const { writeFileSync } = await import('node:fs');
    writeFileSync(`${session.mountDir}/from-host.txt`, 'written on the host\n');

    const out = await session.run('cat /mnt/host/from-host.txt');
    expect(out).toContain('written on the host');
  });

  it('writes through the mount back to the host', async () => {
    session = await startSession();
    await session.run('echo written-in-the-box > /mnt/host/from-box.txt');

    const { readFileSync, existsSync } = await import('node:fs');
    const target = `${session.mountDir}/from-box.txt`;
    expect(existsSync(target)).toBe(true);
    expect(readFileSync(target, 'utf8')).toContain('written-in-the-box');
  });
});
