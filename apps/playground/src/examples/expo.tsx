import { ProjectExample } from '@/examples/project-example';
import { expoAppFiles } from '@/data/templates/expo';

export default function ExpoExample() {
  return (
    <ProjectExample
      title="Expo (React Native Web)"
      subtitle={
        <>
          A React Native app on a live Metro dev server in your browser —{' '}
          <code>npm install</code>, then <code>npm run start</code>. Edit <code>App.js</code> and
          save for Fast Refresh in the preview.
        </>
      }
      files={expoAppFiles('/home/user/expo-app')}
      cwd="/home/user/expo-app"
      previewPort={8081}
    />
  );
}
