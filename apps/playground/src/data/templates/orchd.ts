/**
 * A tiny project carrying an `orchd.json` — the manifest ORCHD uses to describe
 * a project's workloads across substrates (host process, Docker, a Lifo box).
 * The `profiles.lifo` block is the point: in a box the mobile workload runs
 * browser-metro (no node_modules) instead of real Metro.
 */
export function orchdProjectFiles(dir: string): Record<string, string> {
  return {
    [`${dir}/orchd.json`]: JSON.stringify(
      {
        name: 'demo',
        workloads: [
          {
            name: 'api',
            kind: 'node',
            dir: 'api',
            port: 3000,
            run: ['node', 'index.js'],
            port_env: 'PORT',
          },
          {
            name: 'mobile',
            kind: 'node',
            dir: '.',
            port: 8081,
            install: ['npm', 'install'],
            run: ['npx', 'expo', 'start', '--web', '--port', '$PORT'],
            // The app learns where the api landed by NAME — on a host that is a
            // subdomain, in a box it is a port on localhost.
            env: { EXPO_PUBLIC_API_URL: '${url:api}' },
            profiles: {
              lifo: { run: ['browser-metro', '.', '--port', '$PORT'] },
            },
          },
        ],
      },
      null,
      2,
    ) + '\n',

    [`${dir}/package.json`]: JSON.stringify(
      {
        name: 'orchd-demo',
        main: 'index.tsx',
        dependencies: {
          expo: '~54.0.0',
          react: '19.1.0',
          'react-dom': '19.1.0',
          'react-native': '0.81.5',
          'react-native-web': '~0.21.0',
        },
      },
      null,
      2,
    ) + '\n',

    [`${dir}/app.json`]: JSON.stringify(
      { expo: { name: 'orchd-demo', slug: 'orchd-demo', web: { bundler: 'metro' } } },
      null,
      2,
    ) + '\n',

    [`${dir}/index.tsx`]: `import { registerRootComponent } from 'expo';
import App from './App';

registerRootComponent(App);
`,

    [`${dir}/App.tsx`]: `import { StyleSheet, Text, View } from 'react-native';

export default function App() {
  return (
    <View style={styles.container}>
      <Text style={styles.title}>Booted from orchd.json</Text>
      <Text style={styles.body}>
        The manifest travelled with the project. {'\\n'}
        \`orchd resolve\` picked the lifo profile.
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24, gap: 12 },
  title: { fontSize: 22, fontWeight: '600' },
  body: { fontSize: 15, opacity: 0.75, textAlign: 'center', lineHeight: 22 },
});
`,

    [`${dir}/api/index.js`]: `const http = require('http');

const port = Number(process.env.PORT) || 3000;
http
  .createServer((_req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ service: 'api', ok: true }));
  })
  .listen(port, () => console.log('api listening on ' + port));
`,

    [`${dir}/api/package.json`]: JSON.stringify(
      { name: 'orchd-demo-api', private: true, scripts: { start: 'node index.js' } },
      null,
      2,
    ) + '\n',
  };
}
