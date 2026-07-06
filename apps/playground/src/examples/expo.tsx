import { ProjectExample } from '@/examples/project-example';
import { expoAppFiles } from '@/data/templates/expo';

export default function ExpoExample() {
  return (
    <ProjectExample
      title="Expo (React Native Web)"
      subtitle={
        <>
          A React Native app built for the web with Metro — <code>npm install</code>, then{' '}
          <code>npx expo export --platform web</code> and preview the exported build.
        </>
      }
      files={expoAppFiles('/home/user/expo-app')}
      cwd="/home/user/expo-app"
      previewPort={8081}
    />
  );
}
