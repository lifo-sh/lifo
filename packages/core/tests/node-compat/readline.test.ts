import { describe, it, expect } from 'vitest';
import {
  Interface,
  createInterface,
  clearLine,
  clearScreenDown,
  cursorTo,
  moveCursor,
  emitKeypressEvents,
  promises,
} from '../../src/node-compat/readline.js';
import { Readable } from '../../src/node-compat/stream.js';

describe('readline shim', () => {
  describe('createInterface', () => {
    it('returns an Interface instance', () => {
      const rl = createInterface({ input: new Readable() });
      expect(rl).toBeInstanceOf(Interface);
      rl.close();
    });

    it('accepts input/output as positional args', () => {
      const input = new Readable();
      const rl = createInterface(input);
      expect(rl).toBeInstanceOf(Interface);
      rl.close();
    });
  });

  describe('Interface', () => {
    it('emits line events from input data', () => {
      const input = new Readable();
      const rl = createInterface({ input });
      const lines: string[] = [];
      rl.on('line', (line) => lines.push(line as string));

      input.push('hello\nworld\n');
      expect(lines).toEqual(['hello', 'world']);
      rl.close();
    });

    it('emits close event', () => {
      const rl = createInterface({});
      let closed = false;
      rl.on('close', () => { closed = true; });
      rl.close();
      expect(closed).toBe(true);
    });

    it('close is idempotent', () => {
      const rl = createInterface({});
      let count = 0;
      rl.on('close', () => { count++; });
      rl.close();
      rl.close();
      expect(count).toBe(1);
    });

    it('closed property reflects state', () => {
      const rl = createInterface({});
      expect(rl.closed).toBe(false);
      rl.close();
      expect(rl.closed).toBe(true);
    });

    it('setPrompt / getPrompt', () => {
      const rl = createInterface({});
      expect(rl.getPrompt()).toBe('> ');
      rl.setPrompt('$ ');
      expect(rl.getPrompt()).toBe('$ ');
      rl.close();
    });

    it('prompt writes to output', () => {
      const output: string[] = [];
      const rl = createInterface({
        output: { write: (data: string) => { output.push(data); } },
        prompt: '>> ',
      });
      rl.prompt();
      expect(output).toEqual(['>> ']);
      rl.close();
    });

    it('write emits line events', () => {
      const rl = createInterface({});
      const lines: string[] = [];
      rl.on('line', (line) => lines.push(line as string));
      rl.write('foo\nbar');
      expect(lines).toEqual(['foo', 'bar']);
      rl.close();
    });

    it('question writes query and calls back on line', () => {
      const output: string[] = [];
      const rl = createInterface({
        output: { write: (data: string) => { output.push(data); } },
      });
      let answer = '';
      rl.question('Name? ', (a) => { answer = a; });
      expect(output).toEqual(['Name? ']);

      rl.write('Alice');
      expect(answer).toBe('Alice');
      rl.close();
    });

    it('question with options object', () => {
      const rl = createInterface({});
      let answer = '';
      rl.question('Q? ', { signal: AbortSignal.abort() }, (a) => { answer = a; });
      rl.write('yes');
      expect(answer).toBe('yes');
      rl.close();
    });

    it('pause and resume emit events', () => {
      const rl = createInterface({});
      const events: string[] = [];
      rl.on('pause', () => events.push('pause'));
      rl.on('resume', () => events.push('resume'));
      rl.pause();
      rl.resume();
      expect(events).toEqual(['pause', 'resume']);
      rl.close();
    });

    it('getCursorPos returns {rows, cols}', () => {
      const rl = createInterface({});
      expect(rl.getCursorPos()).toEqual({ rows: 0, cols: 0 });
      rl.close();
    });

    it('closes when input ends', () => {
      const input = new Readable();
      const rl = createInterface({ input });
      let closed = false;
      rl.on('close', () => { closed = true; });
      input.push(null);
      expect(closed).toBe(true);
    });

    it('supports async iteration', async () => {
      const rl = createInterface({});
      const lines: string[] = [];

      // Write lines then close after a tick
      setTimeout(() => {
        rl.write('a\nb');
        rl.close();
      }, 0);

      for await (const line of rl) {
        lines.push(line);
      }
      expect(lines).toEqual(['a', 'b']);
    });
  });

  describe('clearLine', () => {
    it('invokes callback and returns true', () => {
      let called = false;
      const result = clearLine({}, 0, () => { called = true; });
      expect(result).toBe(true);
      expect(called).toBe(true);
    });
  });

  describe('clearScreenDown', () => {
    it('invokes callback and returns true', () => {
      let called = false;
      const result = clearScreenDown({}, () => { called = true; });
      expect(result).toBe(true);
      expect(called).toBe(true);
    });
  });

  describe('cursorTo', () => {
    it('invokes callback and returns true', () => {
      let called = false;
      const result = cursorTo({}, 0, 0, () => { called = true; });
      expect(result).toBe(true);
      expect(called).toBe(true);
    });

    it('accepts function as y parameter', () => {
      let called = false;
      const result = cursorTo({}, 0, () => { called = true; });
      expect(result).toBe(true);
      expect(called).toBe(true);
    });
  });

  describe('moveCursor', () => {
    it('invokes callback and returns true', () => {
      let called = false;
      const result = moveCursor({}, 1, 1, () => { called = true; });
      expect(result).toBe(true);
      expect(called).toBe(true);
    });
  });

  describe('emitKeypressEvents', () => {
    it('is a no-op function', () => {
      expect(() => emitKeypressEvents({})).not.toThrow();
    });
  });

  describe('promises API', () => {
    it('createInterface returns interface with promise-based question', async () => {
      const rl = promises.createInterface({});
      // Write answer on next tick
      setTimeout(() => rl.write('yes'), 0);
      const answer = await rl.question('Continue? ');
      expect(answer).toBe('yes');
      rl.close();
    });
  });
});
