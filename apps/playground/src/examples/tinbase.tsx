import { ProjectExample } from '@/examples/project-example';
import { tinbaseTodoAppFiles } from '@/data/templates/tinbase';

export default function TinbaseExample() {
  return (
    <ProjectExample
      title="Supabase Todo (tinbase)"
      subtitle={
        <>
          A Supabase-style app with a real backend in the VM — run <code>npm install</code>, start
          the backend with <code>npm run backend &amp;</code>, then <code>npm run dev</code>. The
          preview has two tabs: your <b>App</b>, and tinbase <b>Studio</b> (the admin dashboard the
          backend serves at <code>/_/</code>) with a table editor, SQL runner, auth users and logs.
        </>
      }
      files={tinbaseTodoAppFiles('/home/user/tinbase-todo')}
      cwd="/home/user/tinbase-todo"
      previews={[
        { label: 'App', port: 5173 },
        { label: 'Studio', port: 54321, path: '/_/' },
      ]}
    />
  );
}
