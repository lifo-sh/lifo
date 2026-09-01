import { describe, it, expect } from 'vitest';
import { CLASSNAME_PATCH_MODULE } from '../../src/commands/system/browser-metro-shims.js';

/**
 * The className patch is injected into the preview as source text, so the only
 * way to test its behaviour is to lift the relevant pieces out and run them.
 *
 * What's pinned here is the unit-suffix rule, which had a real bug: `lineHeight`
 * sat in React DOM's unitless list, so a numeric `lineHeight: 24` was applied as
 * `line-height: 24` — a 24× font-size multiplier in CSS — where React Native and
 * react-native-web mean 24 pixels. Text rendered with enormous line spacing.
 */

/** Evaluate the `_UNITLESS` table straight out of the injected module. */
function unitlessTable(): Record<string, true> {
  const match = CLASSNAME_PATCH_MODULE.match(/var _UNITLESS = (\{[\s\S]*?\n\};)/);
  if (!match) throw new Error('_UNITLESS not found in CLASSNAME_PATCH_MODULE');
  return new Function(`return ${match[1].replace(/;$/, '')};`)() as Record<string, true>;
}

/** The rule the shim applies: numbers get px unless the key is unitless. */
function applied(key: string, value: number | string): string | number {
  const unitless = unitlessTable();
  if (typeof value === 'number' && !unitless[key]) return `${value}px`;
  return value;
}

describe('className patch — numeric style units', () => {
  // Regression: lineHeight used to be listed as unitless.
  it('gives a numeric lineHeight a px suffix (RN semantics, not CSS)', () => {
    expect(unitlessTable().lineHeight).toBeUndefined();
    expect(applied('lineHeight', 24)).toBe('24px');
  });

  it('still leaves genuinely unitless properties alone', () => {
    const unitless = unitlessTable();
    for (const key of ['opacity', 'flex', 'flexGrow', 'fontWeight', 'zIndex', 'aspectRatio', 'lineClamp']) {
      expect(unitless[key], `${key} should be unitless`).toBe(true);
      expect(applied(key, 1)).toBe(1);
    }
  });

  it('adds px to the usual dimensional properties', () => {
    for (const key of ['width', 'height', 'margin', 'padding', 'top', 'fontSize', 'borderRadius']) {
      expect(applied(key, 12)).toBe('12px');
    }
  });

  it('leaves string values untouched, so explicit units survive', () => {
    expect(applied('lineHeight', '1.5')).toBe('1.5');
    expect(applied('width', '50%')).toBe('50%');
    expect(applied('fontSize', '2rem')).toBe('2rem');
  });

  it('the patch module still parses as JavaScript', () => {
    // It is injected into the preview verbatim; a syntax error there is silent
    // until an app renders.
    expect(() => new Function(CLASSNAME_PATCH_MODULE)).not.toThrow();
  });
});

/**
 * Run the whole patch module against a stubbed require() so we can call the
 * patched React.createElement and inspect what props each element type gets.
 */
function runPatch(opts: { rnThrows?: boolean } = {}) {
  const View = { displayName: 'View' };
  const Image = { displayName: 'Image' };
  const RN = { View, Image, Text: { displayName: 'Text' } };
  const calls: Array<{ type: unknown; props: Record<string, unknown> | null }> = [];
  const React = {
    createElement: (type: unknown, props: Record<string, unknown> | null) => {
      calls.push({ type, props });
      return { type, props };
    },
  };
  const requireStub = (name: string) => {
    if (name === 'react') return React;
    if (name === 'react-native') {
      if (opts.rnThrows) throw new Error('not bundled');
      return RN;
    }
    throw new Error(`unexpected require: ${name}`);
  };
  new Function('require', 'module', 'exports', CLASSNAME_PATCH_MODULE)(
    requireStub, { exports: {} }, {},
  );
  return { React, RN, calls };
}

describe('className patch — which element types are converted', () => {
  it('converts className to a $$css style on RN primitives', () => {
    const { React, RN } = runPatch();
    const el = React.createElement(RN.Image, { className: 'h-36 w-full' }) as {
      props: { className?: string; style?: Record<string, unknown> };
    };
    expect(el.props.className).toBeUndefined();
    expect(el.props.style).toEqual({ $$css: true, 'h-36': 'h-36', 'w-full': 'w-full' });
  });

  // Regression: converting on EVERY type deleted className before user
  // components could read it — a component interpolating a caller-passed
  // className into its own template got '' and the caller's classes vanished
  // (an image cover sized by h-36 collapsed to 0px in the preview).
  it('leaves user function components untouched so they can read className', () => {
    const { React } = runPatch();
    const UserComponent = () => null;
    const props = { className: 'h-36 w-full', other: 1 };
    const el = React.createElement(UserComponent, props) as { props: Record<string, unknown> };
    expect(el.props).toBe(props); // passthrough, not even cloned
    expect(el.props.className).toBe('h-36 w-full');
    expect(el.props.style).toBeUndefined();
  });

  it('leaves DOM tags untouched (the Tailwind CDN styles class attributes natively)', () => {
    const { React } = runPatch();
    const props = { className: 'h-36' };
    const el = React.createElement('div', props) as { props: Record<string, unknown> };
    expect(el.props).toBe(props);
  });

  it('falls back to converting everywhere when react-native cannot be required', () => {
    const { React } = runPatch({ rnThrows: true });
    const UserComponent = () => null;
    const el = React.createElement(UserComponent, { className: 'h-36' }) as {
      props: { className?: string; style?: Record<string, unknown> };
    };
    expect(el.props.className).toBeUndefined();
    expect(el.props.style).toEqual({ $$css: true, 'h-36': 'h-36' });
  });
});
