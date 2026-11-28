// util.parseArgs matches Node's: compared case by case with the real one (tests run on Node).
import { describe, it, expect } from 'vitest';
import { parseArgs as nodeParseArgs } from 'node:util';
import { parseArgs } from '../../src/node-compat/util.js';

const plain = (v: unknown) => JSON.parse(JSON.stringify(v));
const outcome = (fn: () => unknown) => {
	try {
		return { ok: plain(fn()) };
	} catch (e) {
		return { code: (e as { code?: string }).code };
	}
};

const options = {
	port: { type: 'string', short: 'p' },
	verbose: { type: 'boolean', short: 'v' },
	quiet: { type: 'boolean', short: 'q' },
	import: { type: 'string', multiple: true },
	host: { type: 'string', default: 'localhost' },
} as const;

const cases: Array<[string, Parameters<typeof nodeParseArgs>[0]]> = [
	['long, inline and separate values', { args: ['--port=3000', '--import', 'a', '--import=b', '-v'], options, tokens: true }],
	['short groups and inline short values', { args: ['-vq', '-p8080'], options, tokens: true }],
	['short with a separate value', { args: ['-p', '9000', 'file'], options, allowPositionals: true, tokens: true }],
	['terminator', { args: ['-v', '--', '--port', 'x'], options, allowPositionals: true, tokens: true }],
	['loose: unknown options and positionals', { args: ['--max-old-space-size=4096', '--enable-source-maps', '--inspect', '127.0.0.1:9229', 'x'], strict: false, tokens: true, options: { import: { type: 'string', multiple: true } } }],
	['negation', { args: ['--no-verbose'], options, allowNegative: true }],
	['strict: unknown option', { args: ['--nope'], options }],
	['strict: missing value', { args: ['--port'], options }],
	['strict: value that looks like an option', { args: ['--port', '--verbose'], options }],
	['strict: boolean with a value', { args: ['--verbose=1'], options }],
	['strict: unexpected positional', { args: ['x'], options }],
];

describe('util.parseArgs', () => {
	for (const [name, config] of cases) {
		it(name, () => {
			expect(outcome(() => parseArgs(config as never))).toEqual(outcome(() => nodeParseArgs(config)));
		});
	}
});
