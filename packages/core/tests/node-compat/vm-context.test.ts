// vm contexts: the context object is the script's global scope (Next.js evaluates its
// manifests with runInNewContext and reads what they assign to globalThis).
import { describe, it, expect } from 'vitest';
import { createVm } from '../../src/node-compat/vm.js';

const vm = createVm() as {
	runInNewContext(code: string, ctx?: object): unknown;
	runInContext(code: string, ctx: object): unknown;
	createContext(o?: object): object;
	isContext(o: unknown): boolean;
	Script: new (code: string) => { runInNewContext(ctx?: object): unknown };
};

describe('vm contexts', () => {
	it('puts globalThis assignments on the context, as a Next.js manifest does', () => {
		const ctx: Record<string, unknown> = { process: { env: { NEXT_DEPLOYMENT_ID: 'x' } } };
		vm.runInNewContext(`globalThis.__RSC_MANIFEST = globalThis.__RSC_MANIFEST || {}; globalThis.__RSC_MANIFEST["/page"] = { id: process.env.NEXT_DEPLOYMENT_ID };`, ctx);
		expect(ctx.__RSC_MANIFEST).toEqual({ '/page': { id: 'x' } });
		expect((globalThis as Record<string, unknown>).__RSC_MANIFEST).toBeUndefined();
	});

	it('reads and writes free variables on the context, keeps built-ins, and returns the completion value', () => {
		const ctx = vm.createContext({ a: 2 });
		expect(vm.isContext(ctx)).toBe(true);
		expect(vm.runInContext('b = a * 21; JSON.stringify([b, typeof Array, this === globalThis])', ctx)).toBe('[42,"function",true]');
		expect((ctx as Record<string, unknown>).b).toBe(42);
		expect(new vm.Script('typeof notDefinedAnywhere').runInNewContext()).toBe('undefined');
	});
});
