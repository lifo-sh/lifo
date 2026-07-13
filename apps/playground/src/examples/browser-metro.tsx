import { ProjectExample } from '@/examples/project-example';

export default function BrowserMetroExample() {
  return (
    <ProjectExample
      title="browser-metro (light Metro)"
      subtitle={
        <>
          A Metro <em>replacement</em> that runs inside Lifo. Scaffold a real Expo app with{' '}
          <strong>no install</strong> — <code>npx create-expo-app my-app --no-install</code>,{' '}
          <code>cd my-app</code>, then <code>browser-metro</code>. There are <em>no</em>{' '}
          <code>node_modules</code>: your files are sucrase-transformed in the VM and npm packages
          come pre-built from <code>esm.reactnative.run</code> — a ~2&nbsp;MB self-contained bundle
          on port 8081. Edit a screen and save to reload.
          <span className="block mt-1.5 text-tokyo-comment/80">
            It&apos;s a switchable option — run <code>npx expo start --web</code> instead for real
            Metro (installs <code>node_modules</code>) when you need full fidelity. Images are
            materialized as blob URLs from the VFS; fonts (e.g. <code>@expo/vector-icons</code>) come
            inlined from the package server.
          </span>
        </>
      }
      files={{}}
      cwd="/home/user"
      previewPort={8081}
      // create-expo-app downloads the template from the network (do NOT set
      // EXPO_OFFLINE); these silence telemetry/version/dep-validation/browser
      // calls. --no-install skips node_modules — browser-metro doesn't need them.
      env={{
        EXPO_NO_TELEMETRY: '1',
        EXPO_NO_DEPENDENCY_VALIDATION: '1',
        BROWSER: 'none',
      }}
    />
  );
}
