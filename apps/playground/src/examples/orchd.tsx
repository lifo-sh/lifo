import { ProjectExample } from '@/examples/project-example';
import { orchdProjectFiles } from '@/data/templates/orchd';

export default function OrchdExample() {
  return (
    <ProjectExample
      title="ORCHD (orchd.json)"
      subtitle={
        <>
          Boot a whole project from the manifest that ships <em>inside</em> it. Run{' '}
          <code>orchd up</code> — it starts the api on port 3000 and the app on 8081, tells the app
          where the api landed, and hands you back the prompt (<code>jobs</code> lists them). No{' '}
          <code>node_modules</code>: the <code>lifo</code> profile swaps real Metro for{' '}
          <code>browser-metro</code>. Also try <code>orchd list</code> and{' '}
          <code>orchd resolve --all</code>.
          <span className="block mt-1.5 text-tokyo-comment/80">
            The same <code>orchd.json</code> describes this project on a host, in Docker and here —
            only <code>profiles.lifo</code> differs. Workloads refer to each other by name:{' '}
            <code>${'{url:api}'}</code> becomes <code>http://localhost:3000</code>. Add{' '}
            <code>--json</code> to <code>resolve</code> for{' '}
            <code>{'{ cwd, argv, env, install }'}</code>, which is what a supervising host runs.
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
