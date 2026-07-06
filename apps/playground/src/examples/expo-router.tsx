import { ProjectExample } from '@/examples/project-example';
import { expoRouterAppFiles } from '@/data/templates/expo-router';

export default function ExpoRouterExample() {
  return (
    <ProjectExample
      title="Expo Router"
      subtitle={
        <>
          File-based routing with Expo Router, exported to a static web build — <code>npm install</code>,
          then <code>npx expo export --platform web</code>.
        </>
      }
      files={expoRouterAppFiles('/home/user/expo-router-app')}
      cwd="/home/user/expo-router-app"
      previewPort={8082}
    />
  );
}
