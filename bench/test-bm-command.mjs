#!/usr/bin/env node
/**
 * test-bm-command.mjs — end-to-end (headless) of the in-VM `browser-metro`
 * command: seed a .tsx Expo web app in the VFS, run the command, and confirm it
 * bundles via esm.reactnative.run and serves the bundle on a port. (Render is
 * browser-only; this validates VFS→bundle→serve.)
 */
import { performance } from 'node:perf_hooks';
import { Sandbox } from '../packages/core/dist/index.js';

const T0 = performance.now();
const log = (...a) => console.log(`[${((performance.now() - T0) / 1000).toFixed(1)}s]`, ...a);
process.on('unhandledRejection', (e) => log('REJ:', e?.message || e));

const PORT = 8082, APP = '/home/user/my-app';
const out = (s) => process.stdout.write(s);

const files = {
  [`${APP}/package.json`]: JSON.stringify({ name: 'demo', main: 'index.tsx', dependencies: { expo: '~54.0.0', react: '19.1.0', 'react-dom': '19.1.0', 'react-native': '0.81.5', 'react-native-web': '~0.21.0' } }),
  [`${APP}/index.tsx`]: `import { registerRootComponent } from 'expo';\nimport App from './App';\nregisterRootComponent(App);\n`,
  [`${APP}/App.tsx`]: `import { Text, View } from 'react-native';\nexport default function App(){ return (<View><Text>Hello from browser-metro in Lifo</Text></View>); }\n`,
};

const sb = await Sandbox.create({ files, cwd: APP, persist: false, env: {} });
log('registered browser-metro?', typeof sb.commands.run === 'function' && sb.kernel.portRegistry instanceof Map);

// Run the long-running dev server (do NOT await).
sb.shell.execute(`browser-metro ${APP} --port ${PORT}`, { cwd: APP, onStdout: out, onStderr: out }).catch((e) => log('cmd ended:', e.message));

// Wait for the port to bind.
let bound = false;
for (let i = 0; i < 60; i++) { if (sb.kernel.portRegistry.has(PORT)) { bound = true; break; } await new Promise((r) => setTimeout(r, 500)); }
log('port bound:', bound);

function vmGet(url) {
  const h = sb.kernel.portRegistry.get(PORT);
  if (!h) return { status: 0, bytes: 0, text: '' };
  const vRes = { statusCode: 200, headers: {}, body: '' };
  h({ method: 'GET', url, headers: { host: `localhost:${PORT}` }, body: '' }, vRes);
  return { status: vRes.statusCode, bytes: Buffer.byteLength(vRes.body || ''), text: vRes.body || '', ct: vRes.headers['content-type'] };
}

if (bound) {
  const html = vmGet('/');
  log(`GET / → ${html.status} ${html.ct} | has #root: ${html.text.includes('id="root"')} | has bundle script: ${html.text.includes('/index.bundle')}`);
  const bundle = vmGet('/index.bundle');
  log(`GET /index.bundle → ${bundle.status} ${bundle.ct} | ${(bundle.bytes / 1048576).toFixed(2)} MB | RNW: ${bundle.text.includes('react-native-web')} | registerRootComponent: ${bundle.text.includes('registerRootComponent')}`);
  const ok = html.status === 200 && html.text.includes('id="root"') && bundle.status === 200 && bundle.bytes > 500000;
  console.log('\n' + (ok ? '✅ PASS — in-VM browser-metro command bundles + serves the app on a port' : '❌ FAIL'));
  process.exit(ok ? 0 : 1);
} else {
  console.log('\n❌ FAIL — port never bound');
  process.exit(2);
}
