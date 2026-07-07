export function expoRouterAppFiles(root: string): Record<string, string> {
	const files: Record<string, string> = {};

	files[`${root}/package.json`] = JSON.stringify({
		name: 'expo-router-app',
		version: '1.0.0',
		main: 'index.js',
		scripts: {
			start: 'node start.mjs',
			export: 'node export.mjs',
			serve: 'node serve.mjs',
		},
		dependencies: {
			expo: '~52.0.0',
			react: '18.3.1',
			'react-dom': '18.3.1',
			'react-native': '0.76.5',
			'react-native-web': '~0.19.13',
			'@expo/metro-runtime': '~4.0.1',
			'expo-router': '~4.0.0',
			'expo-linking': '~7.0.0',
			'expo-constants': '~17.0.0',
			'expo-status-bar': '~2.0.0',
			'react-native-safe-area-context': '4.12.0',
			'react-native-screens': '~4.4.0',
		},
	}, null, 2);

	files[`${root}/app.json`] = JSON.stringify({
		expo: {
			name: 'expo-router-app',
			slug: 'expo-router-app',
			scheme: 'lifoexpo',
			platforms: ['web'],
			web: { bundler: 'metro', output: 'single' },
			plugins: ['expo-router'],
		},
	}, null, 2);

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
config.maxWorkers = 1;
config.resolver.useWatchman = false;
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

	// Boot the Expo web dev server (Metro) non-interactively, with Fast Refresh.
	files[`${root}/start.mjs`] = `process.env.NODE_ENV = 'development';
process.env.EXPO_OFFLINE = '1';
// NOTE: do NOT set CI — Expo is already non-interactive here (isInteractive() is
// !CI && stdout.isTTY, and the VM's stdout isn't a TTY), and CI=1 makes Metro
// disable file watching, which kills Fast Refresh.
process.env.BROWSER = 'none';    // don't try to open a system browser
process.env.EXPO_NO_TELEMETRY = '1';
process.env.EXPO_NO_DEPENDENCY_VALIDATION = '1'; // skip the version doctor check

// Metro's efficient recursive watcher (fs.watch(root, { recursive: true })) is
// gated to macOS; the VM reports platform 'lifo', so Metro would fall back to a
// per-directory walker-based watcher that doesn't observe VFS writes (no Fast
// Refresh). Lifo's fs.watch supports { recursive: true }, so force the native
// watcher — this is what makes editing a file rebuild + hot-reload.
try {
  const nw = await import('metro-file-map/src/watchers/NativeWatcher.js');
  const NativeWatcher = nw.default ?? nw;
  NativeWatcher.isSupported = () => true;
} catch (e) { console.warn('[lifo] NativeWatcher patch failed (no Fast Refresh):', e && e.message); }

const { expoStart } = await import('@expo/cli/build/src/start/index.js');
await expoStart([process.cwd(), '--web', '--port', '8082']);
console.log('\\nMetro dev server on http://localhost:8082 — open the preview and edit app/index.js.');
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
