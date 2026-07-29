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

    [`${dir}/README.txt`]: `ORCHD — boot a whole project from the manifest inside it
========================================================

orchd.json describes this project's workloads once, and the same file works on a
host, in Docker, and in a Lifo box. Only profiles.lifo differs.

Getting started
---------------
  orchd up                       start every workload, each on its own port

That's the whole thing: the api comes up on 3000, the app on 8081, and you get
the prompt back. \`jobs\` lists what is running.

Other commands
--------------
  orchd list                     the workloads in the manifest
  orchd resolve -w api           the exact command line it would run
  orchd resolve --all --json     { cwd, argv, env, install } per workload —
                                 what a supervising host would execute
  orchd up --no-install          skip the install step
  orchd up --port-base 9000      assign ports from 9000 up
  orchd --help                   everything else

\`orchd\` on its own prints that help and exits 2 — \`up\` is the verb that starts
things.

How the app finds the api
-------------------------
Workloads refer to each other by NAME, not by a hardcoded address:

  "env": { "EXPO_PUBLIC_API_URL": "\${url:api}" }

In a box that resolves to http://localhost:3000. On a host with subdomains it
resolves to whatever the api landed on there. The app never has to know.

Why there is no node_modules
----------------------------
The mobile workload's default \`run\` is real Metro. The lifo profile swaps it for
browser-metro, which bundles from the VFS — so the box boots without installing
an Expo toolchain. Look at profiles.lifo in orchd.json to see the whole of it.
`,
  };
}
