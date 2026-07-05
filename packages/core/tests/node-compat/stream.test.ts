import { describe, it, expect } from 'vitest';
import { Readable } from '../../src/node-compat/stream.js';

/** Readable subclass producing 0..max-1 via the async pull protocol. */
class CountingSource extends Readable {
  private n = 0;
  constructor(private max: number) {
    super({ objectMode: true });
  }
  override async _read(): Promise<void> {
    await Promise.resolve(); // async producer, like readdirp
    if (this.n >= this.max) {
      this.push(null);
      return;
    }
    this.push(this.n++);
  }
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('node-compat stream.Readable pull protocol', () => {
  it('calls _read on data-listener attach and delivers all chunks then end', async () => {
    const s = new CountingSource(3);
    const got: unknown[] = [];
    const ended = new Promise<void>((res) => s.on('end', () => res()));
    s.on('data', (c) => got.push(c));
    await ended;
    expect(got).toEqual([0, 1, 2]);
  });

  it('emits close after end', async () => {
    const s = new CountingSource(1);
    const events: string[] = [];
    s.on('end', () => events.push('end'));
    s.on('close', () => events.push('close'));
    s.on('data', () => events.push('data'));
    await tick();
    expect(events).toEqual(['data', 'end', 'close']);
  });

  it('buffers passive pushes until a data listener attaches', async () => {
    const s = new Readable({ objectMode: true });
    s.push('a');
    s.push('b');
    s.push(null);
    const got: unknown[] = [];
    const ended = new Promise<void>((res) => s.on('end', () => res()));
    s.on('data', (c) => got.push(c));
    await ended;
    expect(got).toEqual(['a', 'b']);
  });

  it('read() drains the buffer manually', () => {
    const s = new Readable({ objectMode: true });
    s.push('x');
    s.push(null);
    expect(s.read()).toBe('x');
    expect(s.read()).toBe(null);
  });

  it('a passive no-op _read does not spin forever', async () => {
    const s = new Readable({ objectMode: true });
    s.on('data', () => {});
    await tick();
    // still alive and accepting pushes after the flow loop went idle
    const got: unknown[] = [];
    s.on('data', (c) => got.push(c));
    s.push('late');
    expect(got).toEqual(['late']);
  });

  it('destroy(err) emits error and close and stops the stream', async () => {
    const s = new CountingSource(100);
    const events: string[] = [];
    s.on('error', () => events.push('error'));
    s.on('close', () => events.push('close'));
    s.destroy(new Error('boom'));
    expect(events).toEqual(['error', 'close']);
    expect(s.destroyed).toBe(true);
    expect(s.push('more')).toBe(false);
  });

  it('pause stops delivery; resume continues it', async () => {
    const s = new CountingSource(5);
    const got: unknown[] = [];
    const ended = new Promise<void>((res) => s.on('end', () => res()));
    s.on('data', (c) => {
      got.push(c);
      if (got.length === 2) s.pause();
    });
    await tick();
    await tick();
    expect(got).toEqual([0, 1]);
    s.resume();
    await ended;
    expect(got).toEqual([0, 1, 2, 3, 4]);
  });
});
