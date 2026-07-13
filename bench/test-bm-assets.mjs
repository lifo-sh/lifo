#!/usr/bin/env node
/**
 * test-bm-assets.mjs — verify the browser-metro command emits external-asset
 * URIs (assetPublicPath) and serves the raw asset bytes from the dev port.
 */
// Polyfill browser blob APIs so the command's browser path (materialize assets
// as blob: URLs) runs headlessly. Blob is global in Node 22.
const capturedBlobs = [];
globalThis.URL.createObjectURL = (blob) => { const u = 'blob:lifo/' + capturedBlobs.length; capturedBlobs.push(blob); return u; };
globalThis.URL.revokeObjectURL = () => {};

const { Sandbox } = await import('../packages/core/dist/index.js');

const PORT = 8087, APP = '/home/user/my-app';
const out = (s) => process.stdout.write(s);
// 1x1 PNG
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC', 'base64');

const files = {
  [`${APP}/package.json`]: JSON.stringify({ name: 'demo', main: 'index.tsx', dependencies: { expo: '~54.0.0', react: '19.1.0', 'react-dom': '19.1.0', 'react-native': '0.81.5', 'react-native-web': '~0.21.0' } }),
  [`${APP}/App.tsx`]: `import { Image, View } from 'react-native';\nconst logo = require('./assets/logo.png');\nexport default function App(){ return (<View><Image source={logo} style={{width:10,height:10}} /></View>); }\n`,
  [`${APP}/index.tsx`]: `import { registerRootComponent } from 'expo';\nimport App from './App';\nregisterRootComponent(App);\n`,
};

const sb = await Sandbox.create({ files, cwd: APP, persist: false, env: {} });
// Write the binary asset into the VFS.
sb.kernel.vfs.mkdir?.(`${APP}/assets`);
sb.kernel.vfs.writeFile(`${APP}/assets/logo.png`, new Uint8Array(PNG));
console.log('asset written:', sb.kernel.vfs.exists(`${APP}/assets/logo.png`));

sb.shell.execute(`browser-metro ${APP} --port ${PORT}`, { cwd: APP, onStdout: out, onStderr: out }).catch((e) => console.log('cmd:', e.message));
let bound = false;
for (let i = 0; i < 60; i++) { if (sb.kernel.portRegistry.has(PORT)) { bound = true; break; } await new Promise((r) => setTimeout(r, 500)); }
console.log('bound:', bound);
if (!bound) process.exit(2);

const h = sb.kernel.portRegistry.get(PORT);
const get = (url) => { const r = { statusCode: 200, headers: {}, body: '' }; h({ method: 'GET', url, headers: {}, body: '' }, r); return r; };

const bundle = get('/index.bundle').body;
const hasBlob = /blob:lifo\/\d+/.test(bundle);
const hasPath = bundle.includes('/__bm_assets/');
console.log('bundle asset URI → blob:', hasBlob, '| leftover /__bm_assets path:', hasPath);
console.log('blobs created:', capturedBlobs.length, '| first blob size:', capturedBlobs[0]?.size, '(expected', PNG.length + ')');
console.log('first blob type:', capturedBlobs[0]?.type);

const ok = hasBlob && !hasPath && capturedBlobs.length === 1 && capturedBlobs[0].size === PNG.length && capturedBlobs[0].type === 'image/png';
console.log('\n' + (ok ? '✅ PASS — asset materialized as blob: URL from VFS bytes (rewritten in bundle)' : '❌ FAIL'));
process.exit(ok ? 0 : 1);
