import { ProjectExample } from '@/examples/project-example';

export default function CreateViteExample() {
  return (
    <ProjectExample
      title="create-vite (1:1)"
      subtitle={
        <>
          Scaffold a project exactly as you would locally — run{' '}
          <code>npm create vite@latest my-app</code>, <code>cd my-app</code>,{' '}
          <code>npm install</code>, then <code>npm run dev</code>. The box runs in a Web Worker, so
          Vite 8 works: its Rolldown and Oxc run as WebAssembly with threads.
        </>
      }
      files={{}}
      cwd="/home/user"
      previewPort={5173}
      worker
    />
  );
}
