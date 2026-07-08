export function expoRouterAppFiles(root: string): Record<string, string> {
	const files: Record<string, string> = {};

	files[`${root}/package.json`] = JSON.stringify({
		name: 'expo-router-app',
		version: '1.0.0',
		main: 'index.js',
		scripts: {
			start: 'node start.mjs',
			tunnel: 'node start-tunnel.mjs',
			export: 'node export.mjs',
			serve: 'node serve.mjs',
		},
		dependencies: {
			expo: '~54.0.0',
			react: '19.1.0',
			'react-dom': '19.1.0',
			'react-native': '0.81.5',
			'react-native-web': '~0.21.0',
			'@expo/metro-runtime': '~6.1.2',
			'expo-router': '~6.0.24',
			'expo-linking': '~8.0.12',
			'expo-constants': '~18.0.13',
			'expo-status-bar': '~3.0.9',
			'react-native-safe-area-context': '~5.6.0',
			'react-native-screens': '~4.16.0',
		},
	}, null, 2);

	files[`${root}/app.json`] = JSON.stringify({
		expo: {
			name: 'expo-router-app',
			slug: 'expo-router-app',
			scheme: 'lifoexpo',
			platforms: ['ios', 'android', 'web'],
			web: { bundler: 'metro', output: 'single' },
			plugins: ['expo-router'],
		},
	}, null, 2);

	// Conditional config (standard Expo mechanism). The web preview iframe serves
	// the app under /_sw/8082/, so it needs Expo's first-class sub-path option,
	// experiments.baseUrl — inlined as EXPO_BASE_URL at transform time, it makes
	// Expo Router match routes and generate hrefs/pushState under the prefix.
	// The value comes from LIFO_BASE_URL, set ONLY by the web launcher (start.mjs);
	// the native launcher (start-tunnel.mjs, Expo Go over the tunnel) leaves it
	// unset because the app is served at the tunnel root, not a sub-path. Outside
	// Lifo the var is never set, so this is a no-op (dev server at the domain root).
	files[`${root}/app.config.js`] = `const baseUrl = process.env.LIFO_BASE_URL;

module.exports = ({ config }) => ({
  ...config,
  experiments: {
    ...config.experiments,
    ...(baseUrl ? { baseUrl } : {}),
  },
});
`;

	// Fast Refresh requires the react-refresh runtime (installed by
	// @expo/metro-runtime) to load BEFORE any component module — Metro only
	// registers a module's components if global.__ReactRefresh exists when the
	// module executes. So it must be the first import of the entry file.
	files[`${root}/index.js`] = `import '@expo/metro-runtime';
import 'expo-router/entry';
`;

	files[`${root}/babel.config.js`] = `module.exports = function (api) {
  api.cache(true);
  return { presets: ['babel-preset-expo'] };
};
`;

	files[`${root}/metro.config.js`] = `const { getDefaultConfig } = require('expo/metro-config');
const config = getDefaultConfig(__dirname);

if (require('os').platform() === 'lifo') {
  // In-band Metro (no worker forks), no Watchman binary.
  config.maxWorkers = 1;
  config.resolver.useWatchman = false;

  // With experiments.baseUrl (see app.config.js), the page's script src is
  // /_sw/8082/index.bundle and the HMR client registers that full URL as its
  // entry point. Metro resolves entries against the server root, so strip the
  // prefix from incoming URLs (Metro applies rewriteRequestUrl to both HTTP
  // and HMR-registration URLs).
  const prevRewrite = config.server.rewriteRequestUrl;
  config.server.rewriteRequestUrl = (url) => {
    const stripped = url.replace(/^(https?:\\/\\/[^/]+)?\\/_sw\\/\\d+/, '$1');
    return prevRewrite ? prevRewrite(stripped) : stripped;
  };
}

module.exports = config;
`;

	// File-based routes: app/_layout.js is the root Stack, then two screens.
	files[`${root}/app/_layout.js`] = `import { Stack } from 'expo-router';

export default function Layout() {
  return <Stack screenOptions={{ headerStyle: { backgroundColor: '#1a1b26' }, headerTintColor: '#c0caf5' }} />;
}
`;

	files[`${root}/app/index.js`] = `import { StyleSheet, Text, View } from 'react-native';
import { Link } from 'expo-router';

export default function Home() {
  return (
    <View style={styles.container}>
      <Text style={styles.title}>Expo Router in Lifo 🧭</Text>
      <Text style={styles.body}>File-based routing, bundled by Metro in your browser.</Text>
      <Link href="/about" style={styles.link}>Go to About →</Link>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: '#1a1b26', padding: 24 },
  title: { fontSize: 26, fontWeight: '700', color: '#c0caf5', marginBottom: 10 },
  body: { fontSize: 15, color: '#9aa5ce', marginBottom: 20, textAlign: 'center' },
  link: { fontSize: 16, color: '#7aa2f7', fontWeight: '600' },
});
`;

	files[`${root}/app/about.js`] = `import { StyleSheet, Text, View } from 'react-native';
import { Link } from 'expo-router';

export default function About() {
  return (
    <View style={styles.container}>
      <Text style={styles.title}>About</Text>
      <Text style={styles.body}>This screen lives at app/about.js — the route is /about.</Text>
      <Link href="/" style={styles.link}>← Back Home</Link>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: '#1a1b26', padding: 24 },
  title: { fontSize: 26, fontWeight: '700', color: '#c0caf5', marginBottom: 10 },
  body: { fontSize: 15, color: '#9aa5ce', marginBottom: 20, textAlign: 'center' },
  link: { fontSize: 16, color: '#7aa2f7', fontWeight: '600' },
});
`;

	// Boot the Expo web dev server (Metro) with Fast Refresh. Portable: on a real
	// machine this is equivalent to \`expo start --web\`; the Lifo-specific
	// adaptations only apply when os.platform() === 'lifo'.
	files[`${root}/start.mjs`] = `import os from 'os';
const isLifo = os.platform() === 'lifo';

process.env.NODE_ENV = 'development';
process.env.EXPO_NO_TELEMETRY = '1';
// NOTE: do NOT set CI — Expo is non-interactive without a TTY anyway, and CI=1
// makes Metro disable file watching, which kills Fast Refresh.

if (isLifo) {
  process.env.EXPO_OFFLINE = '1';
  process.env.BROWSER = 'none';    // the preview iframe IS the browser
  process.env.EXPO_NO_DEPENDENCY_VALIDATION = '1'; // skip the version doctor check
  process.env.LIFO_BASE_URL = '/_sw/8082'; // web preview is served under this sub-path (see app.config.js)

  // Metro's efficient recursive watcher (fs.watch(root, { recursive: true })) is
  // gated to macOS; the VM reports platform 'lifo', so Metro would fall back to
  // a per-directory walker-based watcher that doesn't observe VFS writes (no
  // Fast Refresh). Lifo's fs.watch supports { recursive: true }, so force the
  // native watcher — this is what makes editing a file rebuild + hot-reload.
  try {
    const nw = await import('metro-file-map/src/watchers/NativeWatcher.js');
    const NativeWatcher = nw.default ?? nw;
    NativeWatcher.isSupported = () => true;
  } catch (e) { console.warn('[lifo] NativeWatcher patch failed (no Fast Refresh):', e && e.message); }

  // expo-router hard-disables baseUrl handling in development (stripBaseUrl /
  // appendBaseUrl are gated on NODE_ENV !== 'development'), assuming the dev
  // server is always at the domain root. Under Lifo the app legitimately serves
  // at /_sw/8082 (experiments.baseUrl, see app.config.js), so remove the gate —
  // otherwise the router sees pathname /_sw/8082/ and shows "Unmatched Route".
  // Patched at the source so Metro bundles the corrected code.
  try {
    const fs = await import('fs');
    const gate = "= process.env.EXPO_BASE_URL) {\\n    if (process.env.NODE_ENV !== 'development') {";
    const opened = "= process.env.EXPO_BASE_URL) {\\n    if (true) { // lifo: baseUrl applies in dev too (served under /_sw/<port>)";
    for (const f of [
      'node_modules/expo-router/build/fork/getStateFromPath-forks.js',
      'node_modules/expo-router/build/fork/getPathFromState-forks.js',
      'node_modules/expo-router/build/fork/getPathFromState.js',
    ]) {
      const src = fs.readFileSync(f, 'utf8');
      if (src.includes(gate)) fs.writeFileSync(f, src.replace(gate, opened));
    }
  } catch (e) { console.warn('[lifo] expo-router baseUrl patch failed:', e && e.message); }
}

const { expoStart } = await import('@expo/cli/build/src/start/index.js');
await expoStart([process.cwd(), '--web', '--port', '8082']);
console.log('\\nMetro dev server on http://localhost:8082 — open the preview and edit app/index.js.');
await new Promise(() => {}); // keep the dev server alive
`;

	// Boot the dev server for a PHYSICAL PHONE via Expo Go (native bundle), served
	// over the Lifo tunnel. Runs plain \`expo start\` (no --web) so the manifest
	// serves for Expo Go. NOTE: no LIFO_BASE_URL here — native is served at the
	// tunnel root (EXPO_PACKAGER_PROXY_URL), not the /_sw sub-path, so the router
	// must NOT apply a baseUrl.
	//
	// Setup:
	//   1. On your Mac:   node apps/tunnel-server/server.js
	//   2. In this VM:    tunnel --port 8082 &
	//   3. In this VM:    export EXPO_PACKAGER_PROXY_URL=http://<your-mac-LAN-ip>:3005
	//   4. In this VM:    npm run tunnel
	//   5. Scan the printed QR with Expo Go.
	files[`${root}/start-tunnel.mjs`] = `import os from 'os';
const isLifo = os.platform() === 'lifo';

process.env.NODE_ENV = 'development';
process.env.EXPO_NO_TELEMETRY = '1';

if (isLifo) {
  process.env.EXPO_OFFLINE = '1';
  process.env.BROWSER = 'none';
  process.env.EXPO_NO_DEPENDENCY_VALIDATION = '1';
  try {
    const nw = await import('metro-file-map/src/watchers/NativeWatcher.js');
    const NativeWatcher = nw.default ?? nw;
    NativeWatcher.isSupported = () => true;
  } catch (e) { console.warn('[lifo] NativeWatcher patch failed (no Fast Refresh):', e && e.message); }
}

const proxy = process.env.EXPO_PACKAGER_PROXY_URL;
if (!proxy) {
  console.warn('\\n[lifo] EXPO_PACKAGER_PROXY_URL is not set — the phone will get');
  console.warn('       unreachable localhost URLs. Before running this, do:');
  console.warn('         export EXPO_PACKAGER_PROXY_URL=http://<your-mac-LAN-ip>:3005\\n');
}

const { expoStart } = await import('@expo/cli/build/src/start/index.js');
await expoStart([process.cwd(), '--port', '8082']); // no --web: serve the native manifest

if (proxy) {
  const expUrl = proxy.replace(/^https?:\\/\\//, 'exp://');
  console.log('\\nOpen in Expo Go:  ' + expUrl);
  try {
    const qrmod = await import('qrcode-terminal');
    const qrcode = qrmod.default ?? qrmod;
    qrcode.generate(expUrl, { small: true });
  } catch (e) { console.warn('[lifo] QR render failed (type the URL above manually):', e && e.message); }
}
console.log('\\nMetro running (native). Keep this open; edits hot-reload on the device.');
await new Promise(() => {}); // keep the dev server alive
`;

	files[`${root}/export.mjs`] = `process.env.NODE_ENV = 'production';
process.env.EXPO_OFFLINE = '1';
const { expoExport } = await import('@expo/cli/build/src/export/index.js');
await expoExport([process.cwd(), '--platform', 'web', '--output-dir', 'dist', '--max-workers', '1']);
console.log('\\nExport complete — dist/ ready. Now run: npm run serve');
`;

	files[`${root}/serve.mjs`] = `import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const DIST = '${root}/dist';
const PORT = 8082;
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json', '.map': 'application/json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf',
};

http.createServer((req, res) => {
  let p = decodeURIComponent((req.url || '/').split('?')[0]);
  if (p === '/') p = '/index.html';
  let file = path.join(DIST, p);
  try {
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(DIST, 'index.html');
    const data = fs.readFileSync(file);
    res.setHeader('Content-Type', TYPES[path.extname(file)] || 'application/octet-stream');
    res.end(data);
  } catch {
    res.statusCode = 404;
    res.end('Not found');
  }
}).listen(PORT, () => console.log('Serving dist/ at http://localhost:' + PORT));
`;

	return files;
}
