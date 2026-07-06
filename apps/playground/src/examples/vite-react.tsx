import { ProjectExample } from '@/examples/project-example';
import { viteReactAppFiles } from '@/data/templates/vite-react';

export default function ViteReactExample() {
  return (
    <ProjectExample
      title="Vite with React"
      subtitle={
        <>
          A stock Vite + React app running in the VM — <code>npm install</code>, then{' '}
          <code>npm run dev</code>, and the preview loads over the service worker with live HMR.
        </>
      }
      files={viteReactAppFiles('/home/user/react-app', false)}
      cwd="/home/user/react-app"
      previewPort={5173}
    />
  );
}
