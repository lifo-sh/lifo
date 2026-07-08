export function expoAppFiles(root: string): Record<string, string> {
	const files: Record<string, string> = {};

	files[`${root}/package.json`] = JSON.stringify({
		name: 'expo-app',
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
		},
	}, null, 2);

	files[`${root}/app.json`] = JSON.stringify({
		expo: {
			name: 'expo-app',
			slug: 'expo-app',
			platforms: ['web'],
			web: { bundler: 'metro', output: 'single' },
		},
	}, null, 2);

	// Fast Refresh requires the react-refresh runtime to be installed BEFORE any
	// component module executes — Metro registers a module's components only if
	// global.__ReactRefresh exists when the module loads. So @expo/metro-runtime
	// must be the first import of the ENTRY file (the standard Expo web pattern),
	// not of App.js: importing it inside App.js runs too late, leaving the initial
	// App unregistered → every edit "invalidates" the boundary → full reload.
	files[`${root}/index.js`] = `import '@expo/metro-runtime';
import { registerRootComponent } from 'expo';
import App from './App';

registerRootComponent(App);
`;

	files[`${root}/App.js`] = `import { useState } from 'react';
import { StyleSheet, Text, View, Pressable } from 'react-native';

export default function App() {
  const [count, setCount] = useState(0);
  return (
    <View style={styles.container}>
      <Text style={styles.title}>Expo inside Lifo 🚀</Text>
      <Text style={styles.subtitle}>
        Served by a Metro dev server running in your browser. Edit App.js and
        save — Fast Refresh updates it in place, keeping the counter value.
      </Text>
      <View style={styles.row}>
        <Pressable style={styles.btn} onPress={() => setCount((c) => c - 1)}>
          <Text style={styles.btnText}>–</Text>
        </Pressable>
        <Text style={styles.count}>{count}</Text>
        <Pressable style={styles.btn} onPress={() => setCount((c) => c + 1)}>
          <Text style={styles.btnText}>+</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: '#1a1b26', padding: 24 },
  title: { fontSize: 28, fontWeight: '700', color: '#c0caf5', marginBottom: 12 },
  subtitle: { fontSize: 15, color: '#9aa5ce', textAlign: 'center', maxWidth: 420, lineHeight: 22, marginBottom: 24 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 20 },
  btn: { width: 44, height: 44, borderRadius: 22, backgroundColor: '#7aa2f7', alignItems: 'center', justifyContent: 'center' },
  btnText: { fontSize: 24, fontWeight: '700', color: '#1a1b26' },
  count: { fontSize: 28, fontWeight: '700', color: '#c0caf5', minWidth: 48, textAlign: 'center' },
});
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
}

module.exports = config;
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
}

const { expoStart } = await import('@expo/cli/build/src/start/index.js');
await expoStart([process.cwd(), '--web', '--port', '8081']);
console.log('\\nMetro dev server on http://localhost:8081 — open the preview and edit App.js.');
await new Promise(() => {}); // keep the dev server alive
`;

	// The \`expo export\` CLI doesn't await its async command, so run it directly.
	files[`${root}/export.mjs`] = `process.env.NODE_ENV = 'production';
process.env.EXPO_OFFLINE = '1';
const { expoExport } = await import('@expo/cli/build/src/export/index.js');
await expoExport([process.cwd(), '--platform', 'web', '--output-dir', 'dist', '--max-workers', '1']);
console.log('\\nExport complete — dist/ ready. Now run: npm run serve');
`;

	// Static file server for the exported dist/ (SPA fallback to index.html).
	files[`${root}/serve.mjs`] = `import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const DIST = '${root}/dist';
const PORT = 8081;
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
