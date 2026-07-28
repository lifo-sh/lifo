import { describe, it, expect } from 'vitest';
import { parseExpose } from '../src/args.js';

/**
 * Pure parsing for `--expose`. Fast, so the mapping rules are pinned here rather
 * than only through a booted session.
 */
describe('parseExpose', () => {
  it('maps a bare port to the same port on the host', () => {
    expect(parseExpose('3000')).toEqual({ vmPort: 3000, hostPort: 3000 });
  });

  it('maps vmPort:hostPort', () => {
    expect(parseExpose('3000:5000')).toEqual({ vmPort: 3000, hostPort: 5000 });
    expect(parseExpose('5173:8080')).toEqual({ vmPort: 5173, hostPort: 8080 });
  });

  it('accepts the edges of the port range', () => {
    expect(parseExpose('1')).toEqual({ vmPort: 1, hostPort: 1 });
    expect(parseExpose('65535:65535')).toEqual({ vmPort: 65535, hostPort: 65535 });
  });

  it('rejects out-of-range ports', () => {
    expect(parseExpose('0')).toBeNull();
    expect(parseExpose('65536')).toBeNull();
    expect(parseExpose('3000:0')).toBeNull();
    expect(parseExpose('3000:70000')).toBeNull();
    expect(parseExpose('-1')).toBeNull();
  });

  it('rejects non-numeric and malformed input', () => {
    expect(parseExpose('abc')).toBeNull();
    expect(parseExpose('3000:abc')).toBeNull();
    expect(parseExpose('3000.5')).toBeNull();
    expect(parseExpose('')).toBeNull();
    expect(parseExpose(':5000')).toBeNull();
    // Three parts is a mistake, not a mapping — better refused than half-read.
    expect(parseExpose('3000:5000:7000')).toBeNull();
  });

  it('treats a trailing colon as "same port", not an error', () => {
    expect(parseExpose('3000:')).toEqual({ vmPort: 3000, hostPort: 3000 });
  });
});
