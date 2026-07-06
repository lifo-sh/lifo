import { ProjectExample } from '@/examples/project-example';
import { pgliteFiles } from '@/data/templates/pglite';

export default function PgliteExample() {
  return (
    <ProjectExample
      title="Postgres (PGlite)"
      subtitle={
        <>
          A full Postgres database (PGlite/wasm) running in the VM — <code>npm install</code>, then{' '}
          <code>node query.js</code> to run SQL against it.
        </>
      }
      files={pgliteFiles('/home/user/pg-demo')}
      cwd="/home/user/pg-demo"
    />
  );
}
