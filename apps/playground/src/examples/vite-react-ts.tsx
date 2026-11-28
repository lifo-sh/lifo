import { ProjectExample } from '@/examples/project-example';
import { viteReactAppFiles } from '@/data/templates/vite-react';

export default function ViteReactTsExample() {
  return (
    <ProjectExample
      title="Vite with React + TS"
      subtitle={
        <>
          The same Vite 8 + React 19 app with TypeScript: <code>npm install &amp;&amp; npm run dev</code>,{' '}
          then edit the <code>.tsx</code> files (and type-check with <code>npx tsc</code>) in the box.
        </>
      }
      files={viteReactAppFiles('/home/user/react-ts-app', true, 8)}
      cwd="/home/user/react-ts-app"
      previewPort={5173}
      worker
    />
  );
}
