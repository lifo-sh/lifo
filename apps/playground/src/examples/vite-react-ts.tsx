import { ProjectExample } from '@/examples/project-example';
import { viteReactAppFiles } from '@/data/templates/vite-react';

export default function ViteReactTsExample() {
  return (
    <ProjectExample
      title="Vite with React + TS"
      subtitle={
        <>
          The same Vite + React app with TypeScript — <code>npm install &amp;&amp; npm run dev</code>{' '}
          and edit the <code>.tsx</code> files with full type-checking in the VM.
        </>
      }
      files={viteReactAppFiles('/home/user/react-ts-app', true)}
      cwd="/home/user/react-ts-app"
      previewPort={5173}
    />
  );
}
