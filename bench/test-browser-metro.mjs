#!/usr/bin/env node
/**
 * test-browser-metro.mjs — confirm browser-metro 1.0.31 bundles a .tsx Expo web
 * app via esm.reactnative.run, using RapidNative's real plugin config (RN→RNW
 * alias, React auto-import, shim stubs). Headless core de-risk.
 */
import { performance } from 'node:perf_hooks';
import { VirtualFS, Bundler, typescriptTransformer, createReactRefreshTransformer, createDataBxPathPlugin, createExpoWebShimsPlugin, createUnsupportedWebPackagesPlugin } from '../packages/core/node_modules/browser-metro/dist/index.js';

const T0 = performance.now();
const log = (...a) => console.log(`[${((performance.now() - T0) / 1000).toFixed(1)}s]`, ...a);

const files = {
  '/package.json': { content: JSON.stringify({ name: 'demo', main: 'index.tsx', dependencies: { expo: '~54.0.0', react: '19.1.0', 'react-dom': '19.1.0', 'react-native': '0.81.5', 'react-native-web': '~0.21.0' } }), isExternal: false },
  '/index.tsx': { content: `import { registerRootComponent } from 'expo';\nimport App from './App';\nregisterRootComponent(App);\n`, isExternal: false },
  '/App.tsx': { content: `import { Text, View } from 'react-native';\nexport default function App(){ return (<View><Text>Hello from browser-metro in Lifo</Text></View>); }\n`, isExternal: false },
};

// RapidNative's real expo-web plugin (alias + React import + classname-patch
// prepend), with minimal shim stubs (runtime shims not needed to test bundling).
const isJSX = (f) => f.endsWith('.tsx') || f.endsWith('.jsx');
const hasReactImport = (s) => /\bimport\s+React\b/.test(s) || /\bimport\s+\*\s+as\s+React\b/.test(s);
const expoWebPlugin = {
  name: 'expo-web',
  transformSource({ src, filename }) {
    if (filename.endsWith('.json')) return { src: `module.exports = ${src};` };
    let m = src, changed = false;
    if (isJSX(filename) && !hasReactImport(src)) { m = 'import React from "react";\n' + m; changed = true; }
    if (filename === '/index.tsx' || filename === '/index.ts' || filename === '/index.js') { m = 'require("__classname-patch__");\n' + m; changed = true; }
    return changed ? { src: m } : null;
  },
  transformOutput({ code }) { return { code: 'var __DEV__=false; var global=globalThis;\n' + code }; },
  moduleAliases() { return { 'react-native': 'react-native-web' }; },
  shimModules() { return { '__classname-patch__': 'module.exports={};', 'nativewind': 'module.exports={};', 'react-native-css-interop': 'module.exports={};', 'expo-font': 'module.exports={};' }; },
};

async function main() {
  const vfs = new VirtualFS(files);
  const entry = vfs.getEntryFile();
  log('entry:', entry);
  const bundler = new Bundler(vfs, {
    resolver: { sourceExts: ['web.tsx', 'web.ts', 'web.jsx', 'web.js', 'tsx', 'ts', 'jsx', 'js', 'json'] },
    transformer: createReactRefreshTransformer(typescriptTransformer),
    server: { packageServerUrl: 'https://esm.reactnative.run' },
    plugins: [createDataBxPathPlugin(), expoWebPlugin, createExpoWebShimsPlugin(), createUnsupportedWebPackagesPlugin()],
    routerShim: true,
    env: {},
  });
  try {
    const t = performance.now();
    const b = await bundler.bundle(entry);
    log(`✅ bundled: ${(b.length / 1048576).toFixed(2)} MB in ${((performance.now() - t) / 1000).toFixed(1)}s`);
    log(`   react-native-web present: ${b.includes('react-native-web')} | createElement: ${b.includes('createElement')} | registerRootComponent: ${b.includes('registerRootComponent')}`);
  } catch (e) {
    log('❌ FAILED:', e.message);
  }
  process.exit(0);
}
main().catch((e) => { console.error('FATAL', e); process.exit(1); });
