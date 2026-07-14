import { describe, it, expect } from 'vitest';
import { createVm } from '../../src/node-compat/vm.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

describe('vm shim', () => {
  it('runInThisContext evaluates and returns the completion value', () => {
    const vm = createVm() as any;
    expect(vm.runInThisContext('1 + 2')).toBe(3);
  });

  it('runInThisContext returns a wrapped function (jiti pattern)', () => {
    const vm = createVm() as any;
    const fn = vm.runInThisContext('(function(a, b){ return a + b; })');
    expect(typeof fn).toBe('function');
    expect(fn(2, 3)).toBe(5);
  });

  it('Script.runInThisContext works', () => {
    const vm = createVm() as any;
    const s = new vm.Script('40 + 2');
    expect(s.runInThisContext()).toBe(42);
  });

  it('compileFunction builds a callable with params', () => {
    const vm = createVm() as any;
    const f = vm.compileFunction('return x * 2', ['x']);
    expect(f(21)).toBe(42);
  });
});
