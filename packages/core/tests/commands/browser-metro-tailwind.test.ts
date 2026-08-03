import { describe, it, expect } from 'vitest';
import { extractTailwindConfig } from '../../src/commands/system/browser-metro.js';

/**
 * extractTailwindConfig finds the balanced `module.exports = {...}` block by
 * scanning characters and tracking quote state, then evals it and inlines
 * `theme.extend` into the Tailwind CDN config for the preview.
 *
 * The regression pinned here: the scanner tracked quotes but not comments, so
 * an apostrophe inside a comment ("the source's fonts") opened a phantom
 * string, quote parity flipped for the rest of the file, the closing brace was
 * never found, and the ENTIRE theme was silently dropped. Every CSS-variable
 * class (bg-background etc.) then emitted no CSS and the preview rendered as
 * an unthemed white page while the device rendered the real design.
 */

const FALLBACK = 'tailwind.config={darkMode:"class"}';

describe('extractTailwindConfig — comment handling', () => {
  // The exact shape that broke the APEX.AI project preview.
  it('survives an apostrophe in a line comment', () => {
    const config = `module.exports = {
  theme: {
    extend: {
      // mirroring the source's --font-display / --font-sans / --font-mono vars.
      colors: { background: 'rgb(var(--background) / <alpha-value>)' },
    },
  },
};`;
    const out = extractTailwindConfig(config);
    expect(out).not.toBe(FALLBACK);
    expect(out).toContain('--background');
  });

  it('survives quotes and braces inside a block comment', () => {
    const config = `module.exports = {
  /* it's got 'quotes' and a stray } brace and even a { */
  theme: { extend: { colors: { brand: '#ec305a' } } },
};`;
    expect(extractTailwindConfig(config)).toContain('#ec305a');
  });

  it('does not treat // inside a string as a comment', () => {
    const config = `module.exports = {
  theme: {
    extend: {
      backgroundImage: { hero: "url('https://cdn.example.com/a.png')" },
      colors: { brand: '#ec305a' },
    },
  },
};`;
    const out = extractTailwindConfig(config);
    expect(out).toContain('cdn.example.com');
    expect(out).toContain('#ec305a');
  });

  it('handles a comment on the same line as real config (trailing comment)', () => {
    const config = `module.exports = {
  theme: {
    extend: {
      colors: { brand: '#fff' }, // that's the brand white
    },
  },
};`;
    expect(extractTailwindConfig(config)).toContain('#fff');
  });
});

describe('extractTailwindConfig — existing behaviour kept', () => {
  it('extracts a comment-free config (the old happy path)', () => {
    const config = `module.exports = { darkMode: 'class', theme: { extend: { colors: { x: '#fff' } } } };`;
    expect(extractTailwindConfig(config)).toBe(
      'tailwind.config={darkMode:"class",theme:{extend:{"colors":{"x":"#fff"}}}};'
    );
  });

  it('handles the full template shape: require(), process.env, safelist regex, content globs', () => {
    const config = `/** @type {import('tailwindcss').Config} */
module.exports = {
  darkMode: process.env.DARK_MODE ? process.env.DARK_MODE : 'class',
  content: ['./app/**/*.{html,js,jsx,ts,tsx,mdx}'],
  presets: [require('nativewind/preset')],
  important: 'html',
  safelist: [{ pattern: /(bg|text)-(background|foreground)/ }],
  theme: {
    extend: {
      colors: { background: 'rgb(var(--background) / <alpha-value>)' },
      fontFamily: { display: ['Anton_400Regular'] },
    },
  },
};`;
    const out = extractTailwindConfig(config);
    expect(out).toContain('--background');
    expect(out).toContain('Anton_400Regular');
  });

  it('supports export default', () => {
    const config = `export default { theme: { extend: { colors: { y: '#000' } } } };`;
    expect(extractTailwindConfig(config)).toContain('#000');
  });

  it('falls back safely when there is no theme.extend', () => {
    expect(extractTailwindConfig(`module.exports = { darkMode: 'class' };`)).toBe(FALLBACK);
  });

  it('falls back safely on garbage input', () => {
    expect(extractTailwindConfig('not a config at all')).toBe(FALLBACK);
    expect(extractTailwindConfig('module.exports = {')).toBe(FALLBACK);
  });
});
