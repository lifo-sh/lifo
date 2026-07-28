import { ProjectExample } from '@/examples/project-example';
import { orchdProjectFiles } from '@/data/templates/orchd';

export default function OrchdExample() {
  return (
    <ProjectExample
      title="ORCHD (orchd.json)"
      subtitle={
        <>
          Boot a project from the manifest that ships <em>inside</em> it. Try{' '}
          <code>orchd list</code>, then <code>orchd resolve --workload mobile --port 8081</code> —
          it prints <code>browser-metro . --port 8081</code>. Run that line and the preview lights
          up. No <code>node_modules</code>: the <code>lifo</code> profile swaps real Metro for{' '}
          <code>browser-metro</code>.
          <span className="block mt-1.5 text-tokyo-comment/80">
            The same <code>orchd.json</code> describes this project on a host, in Docker and here —
            only <code>profiles.lifo</code> differs. Add <code>--json</code> to get{' '}
            <code>{'{ cwd, argv, env, install }'}</code> for a supervising host. Prefer{' '}
            <code>resolve</code> over <code>orchd run</code> for dev servers: <code>run</code>{' '}
            buffers output and can&apos;t be aborted.
          </span>
        </>
      }
      files={orchdProjectFiles('/home/user/app')}
      cwd="/home/user/app"
      previewPort={8081}
      pkgs={['git', 'orchd']}
      env={{ EXPO_NO_TELEMETRY: '1', BROWSER: 'none' }}
    />
  );
}
