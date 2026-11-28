import { ProjectExample } from '@/examples/project-example';
import { nextAppFiles } from '@/data/templates/next-app';

export default function NextAppExample() {
  return (
    <ProjectExample
      title="Next.js (App Router)"
      subtitle={
        <>
          A Next.js 16 app in a box in a Web Worker: <code>npm install</code>, then{' '}
          <code>npm run dev</code>. Server components, client components and Fast Refresh run in
          your browser, with webpack and SWC's WebAssembly build.
        </>
      }
      files={nextAppFiles('/home/user/next-app')}
      cwd="/home/user/next-app"
      previewPort={3000}
      env={{ NEXT_TELEMETRY_DISABLED: '1' }}
      worker
    />
  );
}
