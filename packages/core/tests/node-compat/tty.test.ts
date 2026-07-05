import { describe, it, expect } from 'vitest';
import { ReadStream, WriteStream, isatty } from '../../src/node-compat/tty.js';

describe('tty shim', () => {
  describe('ReadStream', () => {
    it('has isTTY = true', () => {
      const rs = new ReadStream();
      expect(rs.isTTY).toBe(true);
    });

    it('isRaw defaults to false', () => {
      const rs = new ReadStream();
      expect(rs.isRaw).toBe(false);
    });

    it('setRawMode returns this', () => {
      const rs = new ReadStream();
      expect(rs.setRawMode(true)).toBe(rs);
    });

    it('inherits Readable functionality', () => {
      const rs = new ReadStream();
      const chunks: string[] = [];
      rs.on('data', (c) => chunks.push(c as string));
      rs.push('hello');
      expect(chunks).toEqual(['hello']);
    });
  });

  describe('WriteStream', () => {
    it('has isTTY = true', () => {
      const ws = new WriteStream();
      expect(ws.isTTY).toBe(true);
    });

    it('has default columns and rows', () => {
      const ws = new WriteStream();
      expect(ws.columns).toBe(80);
      expect(ws.rows).toBe(24);
    });

    it('getWindowSize returns [columns, rows]', () => {
      const ws = new WriteStream();
      expect(ws.getWindowSize()).toEqual([80, 24]);
    });

    it('getColorDepth returns 8', () => {
      const ws = new WriteStream();
      expect(ws.getColorDepth()).toBe(8);
    });

    it('hasColors returns true by default', () => {
      const ws = new WriteStream();
      expect(ws.hasColors()).toBe(true);
      expect(ws.hasColors(256)).toBe(true);
      expect(ws.hasColors(16777216)).toBe(false);
    });

    it('clearLine invokes callback', () => {
      const ws = new WriteStream();
      let called = false;
      ws.clearLine(0, () => { called = true; });
      expect(called).toBe(true);
    });

    it('clearScreenDown invokes callback', () => {
      const ws = new WriteStream();
      let called = false;
      ws.clearScreenDown(() => { called = true; });
      expect(called).toBe(true);
    });

    it('cursorTo invokes callback', () => {
      const ws = new WriteStream();
      let called = false;
      ws.cursorTo(0, 0, () => { called = true; });
      expect(called).toBe(true);
    });

    it('cursorTo accepts function as second arg', () => {
      const ws = new WriteStream();
      let called = false;
      ws.cursorTo(0, () => { called = true; });
      expect(called).toBe(true);
    });

    it('moveCursor invokes callback', () => {
      const ws = new WriteStream();
      let called = false;
      ws.moveCursor(1, 1, () => { called = true; });
      expect(called).toBe(true);
    });

    it('inherits Writable functionality', () => {
      const ws = new WriteStream();
      const chunks: string[] = [];
      ws.on('data', (c) => chunks.push(c as string));
      ws.write('hello');
      expect(chunks).toEqual(['hello']);
    });
  });

  describe('isatty', () => {
    it('returns false for any fd', () => {
      expect(isatty(0)).toBe(false);
      expect(isatty(1)).toBe(false);
      expect(isatty(2)).toBe(false);
    });
  });
});
