import { describe, it, expect, beforeEach } from 'vitest';
import { VFS } from '../../src/kernel/vfs/index.js';
import { createFs } from '../../src/node-compat/fs.js';

describe('node-compat fs.watch', () => {
  let vfs: VFS;
  let fs: ReturnType<typeof createFs>;

  beforeEach(() => {
    vfs = new VFS();
    vfs.mkdir('/proj/src', { recursive: true });
    vfs.writeFile('/proj/src/a.txt', 'one');
    fs = createFs(vfs, '/proj');
  });

  it('watching a file fires change on modify', () => {
    const events: Array<[string, string]> = [];
    fs.watch('/proj/src/a.txt', (e: string, f: string) => events.push([e, f]));
    vfs.writeFile('/proj/src/a.txt', 'two');
    expect(events).toContainEqual(['change', 'a.txt']);
  });

  it('watching a directory fires rename on create and change on modify', () => {
    const events: Array<[string, string]> = [];
    fs.watch('/proj/src', (e: string, f: string) => events.push([e, f]));
    vfs.writeFile('/proj/src/new.txt', 'hello');
    vfs.writeFile('/proj/src/new.txt', 'hello again');
    vfs.unlink('/proj/src/new.txt');
    expect(events[0]).toEqual(['rename', 'new.txt']);
    expect(events).toContainEqual(['change', 'new.txt']);
    expect(events[events.length - 1]).toEqual(['rename', 'new.txt']);
  });

  it('non-recursive dir watch ignores nested paths; recursive reports them', () => {
    const flat: Array<[string, string]> = [];
    const deep: Array<[string, string]> = [];
    fs.watch('/proj', (e: string, f: string) => flat.push([e, f]));
    fs.watch('/proj', { recursive: true }, (e: string, f: string) => deep.push([e, f]));
    vfs.writeFile('/proj/src/a.txt', 'three');
    expect(flat).toEqual([]);
    expect(deep).toContainEqual(['change', 'src/a.txt']);
  });

  it('watchers are independent — closing one leaves the other active', () => {
    const first: string[] = [];
    const second: string[] = [];
    const w1 = fs.watch('/proj/src/a.txt', (e: string) => first.push(e));
    fs.watch('/proj/src/a.txt', (e: string) => second.push(e));
    (w1 as { close(): void }).close();
    vfs.writeFile('/proj/src/a.txt', 'four');
    expect(first).toEqual([]);
    expect(second).toEqual(['change']);
  });

  it('watchFile reports curr/prev stats and unwatchFile stops it', () => {
    const calls: Array<{ curr: { size: number }; prev: { size: number } }> = [];
    const listener = (curr: { size: number }, prev: { size: number }) => calls.push({ curr, prev });
    fs.watchFile('/proj/src/a.txt', listener);
    vfs.writeFile('/proj/src/a.txt', 'longer content');
    expect(calls.length).toBe(1);
    expect(calls[0].curr.size).toBe('longer content'.length);
    expect(calls[0].prev.size).toBe('one'.length);
    fs.unwatchFile('/proj/src/a.txt', listener);
    vfs.writeFile('/proj/src/a.txt', 'x');
    expect(calls.length).toBe(1);
  });
});
