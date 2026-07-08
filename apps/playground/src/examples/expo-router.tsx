import { ProjectExample } from '@/examples/project-example';
import { expoRouterAppFiles } from '@/data/templates/expo-router';
import { DeviceTestingNote } from '@/components/device-testing-note';

export default function ExpoRouterExample() {
  return (
    <ProjectExample
      title="Expo Router"
      subtitle={
        <>
          File-based routing with Expo Router on a live Metro dev server — <code>npm install</code>,
          then <code>npm run start</code>. Edit <code>app/index.js</code> and save for Fast Refresh.
          <DeviceTestingNote port={8082} />
        </>
      }
      files={expoRouterAppFiles('/home/user/expo-router-app')}
      cwd="/home/user/expo-router-app"
      previewPort={8082}
    />
  );
}
