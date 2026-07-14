import { ProjectExample } from '@/examples/project-example';
import { expoSupabaseAppFiles } from '@/data/templates/expo-supabase';

export default function ExpoSupabaseExample() {
  return (
    <ProjectExample
      title="Expo Router + Supabase"
      subtitle={
        <>
          An Expo Router app backed by a Supabase-style server, both running in the VM — run{' '}
          <code>npm install</code>, start the backend with <code>npx tinbase --engine pgmem &amp;</code>{' '}
          (like <code>supabase start</code>), then <code>npm start</code>. Schema and seed live in a
          real <code>supabase/</code> folder (<code>migrations/</code> + <code>seed.sql</code>). The{' '}
          <b>App</b> tab shows the React Native web app (Metro + Fast Refresh); the <b>Studio</b> tab
          is tinbase&apos;s admin dashboard — paste the <code>service_role</code> key printed in the
          terminal to browse the todos table, run SQL, and watch logs.
        </>
      }
      files={expoSupabaseAppFiles('/home/user/expo-supabase')}
      cwd="/home/user/expo-supabase"
      previews={[
        { label: 'App', port: 8083 },
        { label: 'Studio', port: 54321, path: '/_/' },
      ]}
    />
  );
}
