import { ProjectExample } from '@/examples/project-example';

const APP = '/home/user/rn-app';

// A tiny .tsx Expo web app. browser-metro JSX-transforms .tsx/.jsx (not .js),
// so the app uses .tsx. No node_modules are installed — browser-metro fetches
// pre-bundled packages from esm.reactnative.run at bundle time.
const files: Record<string, string> = {
  [`${APP}/package.json`]: JSON.stringify(
    {
      name: 'rn-app',
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
  ),
  [`${APP}/index.tsx`]: `import { registerRootComponent } from 'expo';
import App from './App';

registerRootComponent(App);
`,
  [`${APP}/App.tsx`]: `import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

export default function App() {
  const [count, setCount] = useState(0);
  return (
    <View style={styles.container}>
      <Text style={styles.rocket}>🚀</Text>
      <Text style={styles.title}>browser-metro in Lifo</Text>
      <Text style={styles.subtitle}>
        Bundled in the VM, packages fetched pre-built from esm.reactnative.run — no node_modules.
        Edit App.tsx and save.
      </Text>
      <Pressable style={styles.button} onPress={() => setCount((c) => c + 1)}>
        <Text style={styles.buttonText}>Tapped {count} times</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: '#1a1b26', padding: 24, gap: 12 },
  rocket: { fontSize: 56 },
  title: { color: '#c0caf5', fontSize: 22, fontWeight: '700' },
  subtitle: { color: '#565f89', fontSize: 13, textAlign: 'center', maxWidth: 320, lineHeight: 20 },
  button: { marginTop: 12, flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: '#7aa2f7', paddingVertical: 10, paddingHorizontal: 18, borderRadius: 10 },
  buttonText: { color: '#1a1b26', fontSize: 15, fontWeight: '600' },
});
`,
};

export default function BrowserMetroExample() {
  return (
    <ProjectExample
      title="browser-metro (light Metro)"
      subtitle={
        <>
          A Metro <em>replacement</em> that runs inside Lifo. Instead of installing node_modules and
          running real Metro/Babel in the VM, it sucrase-transforms your files and fetches pre-built
          npm packages from <code>esm.reactnative.run</code> — a ~2&nbsp;MB self-contained bundle, no{' '}
          <code>node_modules</code>. Just run <code>browser-metro</code> (it serves on port 8081).
          <span className="block mt-1.5 text-tokyo-comment/80">
            It&apos;s a switchable option — run <code>npx expo start --web</code> instead for real
            Metro when you need full fidelity. Images are materialized as blob URLs from the VFS,
            and fonts (e.g. <code>@expo/vector-icons</code>) come inlined from the package server.
          </span>
        </>
      }
      files={files}
      cwd={APP}
      previewPort={8081}
    />
  );
}
