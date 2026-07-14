import { describe, it, expect } from 'vitest';
import { parsePackageSpec } from '../../src/commands/system/npm.js';

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
