import { ProjectExample } from '@/examples/project-example';
import { staticAssetsFiles } from '@/data/templates/static-assets';

export default function StaticAssetsExample() {
  return (
    <ProjectExample
      title="Static assets (absolute URLs)"
      subtitle={
        <>
          Run <code>node server.js</code>. The page loads images, CSS, JSON, modules and a Web
          Worker by root-relative URLs like <code>/images/logo.svg</code>, and checks each one. The
          preview lives under <code>/_sw/box_…/8080/</code>, but the service worker routes every
          request by the page or worker that made it, so the box&apos;s server gets the plain paths
          it would get on localhost (its log shows them).
        </>
      }
      files={staticAssetsFiles('/home/user/site')}
      cwd="/home/user/site"
      previewPort={8080}
    />
  );
}
