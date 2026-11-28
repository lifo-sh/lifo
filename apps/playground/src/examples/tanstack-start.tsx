import { ProjectExample } from '@/examples/project-example';
import { tanstackStartFiles } from '@/data/templates/tanstack-start';

export default function TanStackStartExample() {
  return (
    <ProjectExample
      title="TanStack Start"
      subtitle={
        <>
          A TanStack Start app in a box in a Web Worker: <code>npm install</code>, then{' '}
          <code>npm run dev</code>. File-based routes, a server function the home page&apos;s loader
          calls while rendering on the server, client navigation and HMR, on Vite 8.
        </>
      }
      files={tanstackStartFiles('/home/user/tanstack-app')}
      cwd="/home/user/tanstack-app"
      previewPort={3000}
      worker
    />
  );
}
