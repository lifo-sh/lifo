// querystring matches Node's: compared with the real module (tests run on Node).
import { describe, it, expect } from 'vitest';
import * as nodeQs from 'node:querystring';
import qs from '../../src/node-compat/querystring.js';

const plain = (v: unknown) => JSON.parse(JSON.stringify(v));

describe('querystring', () => {
	const objects: Array<Record<string, unknown>> = [
		{ pageExtensions: ['tsx', 'ts', 'jsx', 'js'], page: '/page', isDev: true, n: 3, none: null, inf: Infinity },
		{ 'a b': 'c&d=e', emoji: '🙂', empty: '', list: [] },
		{},
	];
	for (const obj of objects) {
		it(`stringify ${JSON.stringify(obj).slice(0, 40)}`, () => {
			expect(qs.stringify(obj as never)).toBe(nodeQs.stringify(obj as never));
			expect(qs.stringify(obj as never, ';', ':')).toBe(nodeQs.stringify(obj as never, ';', ':'));
		});
	}
	const strings = [
		'pageExtensions=tsx&pageExtensions=ts&pageExtensions=js&page=%2Fpage',
		'a+b=c%20d&&=x&flag&x=1&x=2&x=3',
		'bad=%E0%A4%A&ok=%41&pct=100%',
		'',
		'__proto__=1&constructor=2',
	];
	for (const str of strings) {
		it(`parse ${str.slice(0, 40) || '(empty)'}`, () => {
			expect(plain(qs.parse(str))).toEqual(plain(nodeQs.parse(str)));
			expect(Object.getPrototypeOf(qs.parse(str))).toBe(null);
		});
	}
	it('parse with sep, eq and maxKeys', () => {
		expect(plain(qs.parse('a:1;b:2;c:3', ';', ':', { maxKeys: 2 }))).toEqual(plain(nodeQs.parse('a:1;b:2;c:3', ';', ':', { maxKeys: 2 })));
	});
	it('round-trips arrays (webpack loader options)', () => {
		const opts = { pageExtensions: ['tsx', 'ts'], name: 'app/page' };
		expect(plain(qs.parse(qs.stringify(opts)))).toEqual(opts);
	});
});
