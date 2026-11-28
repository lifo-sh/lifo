import { ProjectExample } from '@/examples/project-example';

export default function CreateNextAppExample() {
  return (
    <ProjectExample
      title="create-next-app (1:1)"
      subtitle={
        <>
          Scaffold a Next.js app exactly as you would locally: run{' '}
          <code>npx create-next-app@latest my-app</code> and take the recommended defaults
          (TypeScript, Tailwind CSS, ESLint, App Router), then <code>cd my-app</code> and{' '}
          <code>npm run dev</code>. Turbopack is native only, so the box runs Next with webpack and
          SWC&apos;s WebAssembly build, and applies the project&apos;s Turbopack loaders (Tailwind) to
          webpack.
        </>
      }
      files={{}}
      cwd="/home/user"
      previewPort={3000}
      env={{ NEXT_TELEMETRY_DISABLED: '1' }}
      worker
    />
  );
}
