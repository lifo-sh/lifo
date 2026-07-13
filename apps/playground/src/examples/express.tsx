import { ProjectExample } from '@/examples/project-example';
import { expressAppFiles } from '@/data/templates/express';

export default function ExpressExample() {
  return (
    <ProjectExample
      title="Node.js + Express"
      subtitle={
        <>
          A real Express server running in the VM — <code>npm install</code>, then{' '}
          <code>node server.js</code>. It serves a JSON API and a static frontend; the preview
          browser talks to it over the service worker.
        </>
      }
      files={expressAppFiles('/home/user/express-app')}
      cwd="/home/user/express-app"
      previewPort={3000}
    />
  );
}
