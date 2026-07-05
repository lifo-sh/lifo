import { describe, it, expect } from 'vitest';
import { builtinModules, isBuiltin, makeCreateRequire, Module, createModuleShim } from '../../src/node-compat/module.js';

describe('module shim', () => {
  describe('builtinModules', () => {
    it('is an array of strings', () => {
      expect(Array.isArray(builtinModules)).toBe(true);
      expect(builtinModules.length).toBeGreaterThan(0);
      for (const m of builtinModules) {
        expect(typeof m).toBe('string');
      }
    });

    it('includes common modules', () => {
      expect(builtinModules).toContain('fs');
      expect(builtinModules).toContain('path');
      expect(builtinModules).toContain('os');
      expect(builtinModules).toContain('events');
      expect(builtinModules).toContain('buffer');
      expect(builtinModules).toContain('crypto');
      expect(builtinModules).toContain('http');
      expect(builtinModules).toContain('stream');
      expect(builtinModules).toContain('url');
      expect(builtinModules).toContain('util');
      expect(builtinModules).toContain('dns');
      expect(builtinModules).toContain('tty');
      expect(builtinModules).toContain('module');
    });
  });

  describe('isBuiltin', () => {
    it('returns true for known builtins', () => {
      expect(isBuiltin('fs')).toBe(true);
      expect(isBuiltin('path')).toBe(true);
      expect(isBuiltin('module')).toBe(true);
    });

    it('handles node: prefix', () => {
      expect(isBuiltin('node:fs')).toBe(true);
      expect(isBuiltin('node:path')).toBe(true);
      expect(isBuiltin('node:events')).toBe(true);
    });

    it('returns false for unknown modules', () => {
      expect(isBuiltin('express')).toBe(false);
      expect(isBuiltin('node:express')).toBe(false);
      expect(isBuiltin('lodash')).toBe(false);
    });
  });

  describe('makeCreateRequire', () => {
    it('returns a createRequire function', () => {
      const createRequire = makeCreateRequire({});
      expect(typeof createRequire).toBe('function');
    });

    it('created require resolves registered modules', () => {
      const fakeFs = { readFileSync: () => '' };
      const createRequire = makeCreateRequire({
        fs: () => fakeFs,
      });
      const req = createRequire('/test.js');
      expect(req('fs')).toBe(fakeFs);
    });

    it('created require strips node: prefix', () => {
      const fakeOs = { platform: () => 'lifo' };
      const createRequire = makeCreateRequire({
        os: () => fakeOs,
      });
      const req = createRequire('/test.js');
      expect(req('node:os')).toBe(fakeOs);
    });

    it('created require caches modules', () => {
      let callCount = 0;
      const createRequire = makeCreateRequire({
        fs: () => { callCount++; return {}; },
      });
      const req = createRequire('/test.js');
      const a = req('fs');
      const b = req('fs');
      expect(a).toBe(b);
      expect(callCount).toBe(1);
    });

    it('created require throws for unknown modules', () => {
      const createRequire = makeCreateRequire({});
      const req = createRequire('/test.js');
      expect(() => req('unknown')).toThrow("Cannot find module 'unknown'");
    });

    it('resolve returns module name for builtins', () => {
      const createRequire = makeCreateRequire({
        fs: () => ({}),
      });
      const req = createRequire('/test.js');
      expect(req.resolve('fs')).toBe('fs');
      expect(req.resolve('node:fs')).toBe('fs');
    });

    it('resolve throws for unknown modules', () => {
      const createRequire = makeCreateRequire({});
      const req = createRequire('/test.js');
      expect(() => req.resolve('unknown')).toThrow("Cannot find module 'unknown'");
    });

    it('require has a cache object', () => {
      const createRequire = makeCreateRequire({ fs: () => ({}) });
      const req = createRequire('/test.js');
      expect(typeof req.cache).toBe('object');
    });
  });

  describe('Module class', () => {
    it('constructs with defaults', () => {
      const m = new Module();
      expect(m.id).toBe('');
      expect(m.filename).toBe('');
      expect(m.exports).toEqual({});
      expect(m.parent).toBeNull();
      expect(m.children).toEqual([]);
      expect(m.loaded).toBe(false);
      expect(m.paths).toEqual([]);
    });

    it('constructs with id and parent', () => {
      const parent = new Module('/parent.js');
      const child = new Module('/child.js', parent);
      expect(child.id).toBe('/child.js');
      expect(child.parent).toBe(parent);
    });

    it('has static builtinModules', () => {
      expect(Module.builtinModules).toBe(builtinModules);
    });

    it('has static isBuiltin', () => {
      expect(Module.isBuiltin('fs')).toBe(true);
      expect(Module.isBuiltin('unknown')).toBe(false);
    });

    it('_resolveFilename returns the request', () => {
      expect(Module._resolveFilename('fs')).toBe('fs');
    });

    it('_cache is an object', () => {
      expect(typeof Module._cache).toBe('object');
    });
  });

  describe('createModuleShim', () => {
    it('returns object with all expected exports', () => {
      const shim = createModuleShim({ fs: () => ({}) });
      expect(shim.Module).toBe(Module);
      expect(shim.builtinModules).toBe(builtinModules);
      expect(shim.isBuiltin).toBe(isBuiltin);
      expect(typeof shim.createRequire).toBe('function');
      expect(shim.default).toBe(Module);
    });

    it('createRequire from shim works', () => {
      const fakeFs = { readFileSync: () => '' };
      const shim = createModuleShim({ fs: () => fakeFs });
      const req = shim.createRequire('/test.js');
      expect(req('fs')).toBe(fakeFs);
    });
  });
});
