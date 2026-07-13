#!/usr/bin/env node
/**
 * test-bm-hmr.mjs — granular HMR for browser-metro: edit a file TWICE and
 * confirm each edit produces a HOT update (not a full reload), delivered via
 * /__bmhmr with the new source in updatedModules.
 */
import { Sandbox } from '../packages/core/dist/index.js';

const PORT = 8090, APP = '/home/user/rn-app';
const out = (s) => process.stdout.write(s);
const files = {
  [`${APP}/package.json`]: JSON.stringify({ name: 'rn-app', main: 'index.tsx', dependencies: { expo: '~54.0.0', react: '19.1.0', 'react-dom': '19.1.0', 'react-native': '0.81.5', 'react-native-web': '~0.21.0' } }),
  [`${APP}/index.tsx`]: `import { registerRootComponent } from 'expo';\nimport App from './App';\nregisterRootComponent(App);\n`,
  [`${APP}/App.tsx`]: `import { Text, View } from 'react-native';\nexport default function App(){ return (<View><Text>MARKER_V0</Text></View>); }\n`,
};

const sb = await Sandbox.create({ files, cwd: APP, persist: false, env: {} });
sb.shell.execute(`browser-metro ${APP} --port ${PORT}`, { cwd: APP, onStdout: out, onStderr: out }).catch((e) => console.log('cmd:', e.message));
let bound = false;
for (let i = 0; i < 60; i++) { if (sb.kernel.portRegistry.has(PORT)) { bound = true; break; } await new Promise((r) => setTimeout(r, 500)); }
console.log('bound:', bound);
if (!bound) process.exit(2);

const h = sb.kernel.portRegistry.get(PORT);
const getJson = (url) => { const r = { statusCode: 200, headers: {}, body: '' }; h({ method: 'GET', url, headers: {}, body: '' }, r); return JSON.parse(r.body); };

// edit App.tsx, then wait until /__bmhmr shows an update past `sinceSeq`
async function editAndWait(marker, sinceSeq) {
  sb.kernel.vfs.writeFile(`${APP}/App.tsx`, `import { Text, View } from 'react-native';\nexport default function App(){ return (<View><Text>${marker}</Text></View>); }\n`);
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 300));
    const d = getJson(`/__bmhmr?b=1&h=${sinceSeq}`);
    if (d.reload) return { reload: true };
    if (d.updates && d.updates.length) return d;
  }
  return { timeout: true };
}

const base = getJson('/__bmhmr?b=1&h=0');
console.log('initial:', JSON.stringify(base));

console.log('--- edit #1 (MARKER_V1) ---');
const d1 = await editAndWait('MARKER_V1', 0);
const u1 = d1.updates && d1.updates[0];
const code1 = u1 ? Object.values(u1.update.updatedModules).join('\n') : '';
console.log('edit#1:', d1.reload ? 'RELOAD' : d1.timeout ? 'TIMEOUT' : `hot seq=${u1.seq}, hasV1=${code1.includes('MARKER_V1')}`);

console.log('--- edit #2 (MARKER_V2) ---');
const d2 = await editAndWait('MARKER_V2', u1 ? u1.seq : 0);
const u2 = d2.updates && d2.updates[0];
const code2 = u2 ? Object.values(u2.update.updatedModules).join('\n') : '';
console.log('edit#2:', d2.reload ? 'RELOAD' : d2.timeout ? 'TIMEOUT' : `hot seq=${u2.seq}, hasV2=${code2.includes('MARKER_V2')}`);

const ok = !d1.reload && !d1.timeout && u1 && code1.includes('MARKER_V1') && !d2.reload && !d2.timeout && u2 && u2.seq > u1.seq && code2.includes('MARKER_V2');
console.log('\n' + (ok ? '✅ PASS — both edits produced HOT updates (no reload)' : '❌ FAIL'));
process.exit(ok ? 0 : 1);
