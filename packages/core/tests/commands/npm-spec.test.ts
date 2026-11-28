import { describe, it, expect } from 'vitest';
import { parsePackageSpec, boxOptionalDependencies, requiredDependencies, unlistedWasiBinding, initializerPackage, satisfiesRange, compareFull } from '../../src/commands/system/npm.js';

describe('parsePackageSpec', () => {
  it('parses plain names', () => {
    expect(parsePackageSpec('lodash')).toEqual({ name: 'lodash', version: null });
  });

  it('parses name@version', () => {
    expect(parsePackageSpec('lodash@4.17.21')).toEqual({ name: 'lodash', version: '4.17.21' });
    expect(parsePackageSpec('inherits@2')).toEqual({ name: 'inherits', version: '2' });
  });

  it('parses scoped names', () => {
    expect(parsePackageSpec('@tinbase/pg-mem')).toEqual({ name: '@tinbase/pg-mem', version: null });
    expect(parsePackageSpec('@tinbase/pg-mem@^3.2.0')).toEqual({ name: '@tinbase/pg-mem', version: '^3.2.0' });
  });

  it('parses npm: alias specs (version contains @)', () => {
    // This is the bug: lastIndexOf split at the wrong @.
    expect(parsePackageSpec('pg-mem@npm:@tinbase/pg-mem@^3.2.0')).toEqual({
      name: 'pg-mem',
      version: 'npm:@tinbase/pg-mem@^3.2.0',
    });
    expect(parsePackageSpec('my-lodash@npm:lodash@^4')).toEqual({
      name: 'my-lodash',
      version: 'npm:lodash@^4',
    });
  });

  it('parses a scoped alias spec', () => {
    expect(parsePackageSpec('@a/b@npm:@c/d@^1')).toEqual({
      name: '@a/b',
      version: 'npm:@c/d@^1',
    });
  });
});

describe('optional dependencies in a box (napi-rs wasm builds)', () => {
	const platforms = (prefix: string) => ({
		[`${prefix}-darwin-arm64`]: '1.2.3',
		[`${prefix}-linux-x64-gnu`]: '1.2.3',
		[`${prefix}-linux-arm-gnueabihf`]: '1.2.3',
		[`${prefix}-win32-x64-msvc`]: '1.2.3',
	});

	it('leaves out optional dependencies a package also lists as dependencies (TypeScript 7)', () => {
		const natives = { '@typescript/typescript-linux-x64': '7.0.2', '@typescript/typescript-darwin-arm64': '7.0.2' };
		const ts7 = { name: 'typescript', dependencies: { ...natives, 'some-js-helper': '^1.0.0' }, optionalDependencies: natives };
		expect(requiredDependencies(ts7)).toEqual([['some-js-helper', '^1.0.0']]);
		expect(requiredDependencies({ dependencies: { a: '1' } })).toEqual([['a', '1']]);
		expect(requiredDependencies({})).toEqual([]);
	});

	it('installs only the listed wasm32-wasi build', () => {
		const info = { name: 'rolldown', optionalDependencies: { ...platforms('@rolldown/binding'), '@rolldown/binding-wasm32-wasi': '1.2.3', fsevents: '~2.3.3' } };
		expect(boxOptionalDependencies(info)).toEqual([['@rolldown/binding-wasm32-wasi', '1.2.3']]);
		expect(unlistedWasiBinding(info)).toBeNull();
	});

	it('infers the wasm32-wasi build a package publishes without listing it', () => {
		const info = { name: 'oxc-parser', optionalDependencies: platforms('@oxc-parser/binding') };
		expect(boxOptionalDependencies(info)).toEqual([]);
		expect(unlistedWasiBinding(info)).toEqual(['@oxc-parser/binding-wasm32-wasi', '1.2.3']);
		expect(unlistedWasiBinding({ name: 'lightningcss', optionalDependencies: platforms('lightningcss') })).toEqual(['lightningcss-wasm32-wasi', '1.2.3']);
	});

	it("doesn't guess for other optional dependencies", () => {
		expect(unlistedWasiBinding({ name: 'esbuild', optionalDependencies: { '@esbuild/linux-x64': '0.28.1', '@esbuild/darwin-arm64': '0.28.1' } })).toBeNull();
		expect(unlistedWasiBinding({ name: 'chokidar', optionalDependencies: { fsevents: '~2.3.3' } })).toBeNull();
		expect(unlistedWasiBinding({ name: 'two', optionalDependencies: { ...platforms('a'), ...platforms('b') } })).toBeNull();
	});

	it('skips packages whose addon Lifo shims in JS', () => {
		const info = { name: '@tailwindcss/oxide', optionalDependencies: { ...platforms('@tailwindcss/oxide'), '@tailwindcss/oxide-wasm32-wasi': '4.3.5' } };
		expect(boxOptionalDependencies(info)).toEqual([]);
		expect(unlistedWasiBinding(info)).toBeNull();
	});
});

describe('npm create / npm init <initializer>', () => {
	it('maps an initializer to its create- package, as npm does', () => {
		expect(initializerPackage('vite')).toBe('create-vite');
		expect(initializerPackage('vite@latest')).toBe('create-vite@latest');
		expect(initializerPackage('@vue')).toBe('@vue/create');
		expect(initializerPackage('@scope/app@2')).toBe('@scope/create-app@2');
	});
});

describe('prerelease versions', () => {
	it('an exact prerelease is only itself (@tanstack/devtools pins @neodrag/core@3.0.0-next.11)', () => {
		expect(satisfiesRange('3.0.0-next.11', '3.0.0-next.11')).toBe(true);
		expect(satisfiesRange('3.0.0-next.0', '3.0.0-next.11')).toBe(false);
		expect(satisfiesRange('3.0.0-next.11', '=3.0.0-next.11')).toBe(true);
	});

	it('a prerelease range takes later prereleases of the same version only', () => {
		expect(satisfiesRange('3.0.0-next.11', '^3.0.0-next.5')).toBe(true);
		expect(satisfiesRange('3.0.0-next.2', '^3.0.0-next.5')).toBe(false);
		expect(satisfiesRange('3.1.0-next.9', '^3.0.0-next.5')).toBe(false);
		expect(satisfiesRange('3.0.0-next.3', '<3.0.0-next.5')).toBe(true);
		expect(satisfiesRange('3.0.0-beta.1', '^3.0.0')).toBe(false);
	});

	it('orders versions as semver does', () => {
		const sorted = ['3.0.0-next.2', '3.0.0', '3.0.0-next.11', '3.0.0-alpha', '3.0.0-next.0', '2.9.9'].sort(compareFull);
		expect(sorted).toEqual(['2.9.9', '3.0.0-alpha', '3.0.0-next.0', '3.0.0-next.2', '3.0.0-next.11', '3.0.0']);
	});
});
