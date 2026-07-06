import { ProjectExample } from '@/examples/project-example';
import { tinbaseTodoAppFiles } from '@/data/templates/tinbase';

export default function TinbaseExample() {
  return (
    <ProjectExample
      title="Supabase Todo (tinbase)"
      subtitle={
        <>
          A Supabase-style app with a real backend in the VM — run <code>npm install</code>, start
          the backend with <code>npm run backend &amp;</code>, then <code>npm run dev</code>.
        </>
      }
      files={tinbaseTodoAppFiles('/home/user/tinbase-todo')}
      cwd="/home/user/tinbase-todo"
      previewPort={5173}
    />
  );
}
