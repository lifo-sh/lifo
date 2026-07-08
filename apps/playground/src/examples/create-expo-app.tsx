import { ProjectExample } from '@/examples/project-example';

export default function CreateExpoAppExample() {
  return (
    <ProjectExample
      title="create-expo-app (1:1)"
      subtitle={
        <>
          Scaffold a real Expo app exactly as you would locally — run{' '}
          <code>npx create-expo-app@latest my-app --template blank</code>, <code>cd my-app</code>,
          then <code>npx expo start --web</code>. No Lifo-specific edits: Metro runs in-band (the VM
          reports a single CPU) and the preview mounts below on port 8081.
          <span className="block mt-1.5 text-tokyo-comment/80">
            Note: create-expo-app calls <code>api.expo.dev</code>, which the browser can't reach
            (no CORS). Run the Lifo relay first — it doubles as a CORS proxy:{' '}
            <code>node apps/tunnel-server/server.js</code> on your Mac. (A hosted proxy will remove
            this step later.)
          </span>
        </>
      }
      files={{}}
      cwd="/home/user"
      previewPort={8081}
      // Defaults a stock project doesn't set for itself, so `expo start` behaves
      // in the VM. NOTE: do NOT set EXPO_OFFLINE — create-expo-app needs the
      // network to download the template tarball (offline → "Could not find npm
      // package"). expo start is fine online; these flags silence the calls that
      // would otherwise stall (telemetry, version/dependency checks, opening a
      // system browser).
      env={{
        EXPO_NO_TELEMETRY: '1',
        EXPO_NO_DEPENDENCY_VALIDATION: '1',
        BROWSER: 'none',
      }}
    />
  );
}
