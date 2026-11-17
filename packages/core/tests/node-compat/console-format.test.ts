import { describe, expect, it } from 'vitest';
import { format } from '../../src/node-compat/util.js';
import { Sandbox } from '../../src/sandbox/Sandbox.js';

// Node's util.format (behind console.log): strings passed as extra arguments print as-is;
// only strings nested inside objects and arrays are quoted.
describe('util.format', () => {
	it('does not quote top-level strings', () => {
		expect(format('a', 'b', 'c')).toBe('a b c');
		expect(format('count:', 3, 'items')).toBe('count: 3 items');
		expect(format(1 as unknown as string, 'x')).toBe('1 x');
	});

	it('quotes strings inside objects and arrays', () => {
		expect(format('obj', { a: 'x' })).toMatch(/a: 'x'/);
		expect(format('arr', ['x'])).toMatch(/'x'/);
	});

	it('handles %s %d %i %f %j %o %c %%', () => {
		expect(format('%s=%d', 'n', 42)).toBe('n=42');
		expect(format('%i %f', '3.9', '2.5')).toBe('3 2.5');
		expect(format('%j', { a: 1 })).toBe('{"a":1}');
		expect(format('%cstyled', 'color: red')).toBe('styled');
		expect(format('100%%')).toBe('100%');
		expect(format('%s', 'only')).toBe('only');
	});
});

describe('console.log in node', () => {
	it('prints extra string arguments without quotes', async () => {
		const box = await Sandbox.create();
		const r = await box.commands.run(`node -e "console.log('hello', 'world', 1, ['a'])"`);
		expect(r.stdout).toBe("hello world 1 [ 'a' ]\n");
	});
});
