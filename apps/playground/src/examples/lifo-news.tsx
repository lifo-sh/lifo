import { ProjectExample } from '@/examples/project-example';
import { lifoNewsFiles } from '@/data/templates/lifo-news.gen';

const ROOT = '/home/user/lifo-news';

export default function LifoNewsExample() {
  return (
    <ProjectExample
      title="Lifo News (full stack)"
      subtitle={
        <>
          A link board with accounts, posts, votes and comment threads: React and supabase-js on{' '}
          <b>tinbase</b>, the Supabase-compatible backend. Run <code>npm install</code>, then{' '}
          <code>supabase start &amp;</code> and <code>npm start</code>. <code>server.js</code> serves
          the app and proxies <code>/rest/v1</code> and <code>/auth/v1</code> to tinbase, so one port
          (3000) carries everything, which is what a tunnel or a Lifo Cloud box needs. Schema, row
          level security and seed are in <code>supabase/</code>.
        </>
      }
      files={lifoNewsFiles(ROOT)}
      cwd={ROOT}
      previews={[
        { label: 'App', port: 3000 },
        { label: 'Studio', port: 54321, path: '/_/' },
      ]}
    />
  );
}
