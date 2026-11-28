import { ProjectExample } from '@/examples/project-example';

export default function CreateTanStackExample() {
  return (
    <ProjectExample
      title="TanStack CLI (1:1)"
      subtitle={
        <>
          Scaffold a TanStack Start app exactly as you would locally: run{' '}
          <code>npx @tanstack/cli@latest create my-app</code> and answer its prompts (or add{' '}
          <code>--yes</code> for the defaults), then <code>cd my-app</code> and{' '}
          <code>npm run dev</code>. The CLI installs, sets up git and generates the route tree in the
          box.
        </>
      }
      files={{}}
      cwd="/home/user"
      previewPort={3000}
      env={{ TANSTACK_CLI_TELEMETRY_DISABLED: '1' }}
      worker
    />
  );
}
