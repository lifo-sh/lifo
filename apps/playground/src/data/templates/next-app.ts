/**
 * A Next.js App Router app, the shape create-next-app scaffolds (without Tailwind or
 * TypeScript): a server-rendered page with a client component, so the preview shows server
 * rendering, hydration (the counter) and Fast Refresh.
 */
export function nextAppFiles(root: string): Record<string, string> {
	const files: Record<string, string> = {};

	files[`${root}/package.json`] = JSON.stringify({
		name: root.split('/').pop(),
		version: '0.1.0',
		private: true,
		scripts: { dev: 'next dev', build: 'next build', start: 'next start' },
		dependencies: { next: '16.4.6', react: '19.2.3', 'react-dom': '19.2.3' },
	}, null, 2);

	files[`${root}/app/layout.js`] = `import './globals.css';

export const metadata = {
  title: 'Next.js in Lifo',
  description: 'A Next.js app running in your browser',
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
`;

	files[`${root}/app/page.js`] = `import Counter from './counter';

export default function Home() {
  return (
    <main>
      <h1>Next.js inside Lifo</h1>
      <p>This page was rendered on the server by Next.js running in your browser.</p>
      <Counter />
      <p className="hint">Edit <code>app/page.js</code> and save to see Fast Refresh.</p>
    </main>
  );
}
`;

	files[`${root}/app/counter.js`] = `'use client';

import { useState } from 'react';

export default function Counter() {
  const [count, setCount] = useState(0);
  return <button onClick={() => setCount(count + 1)}>count is {count}</button>;
}
`;

	files[`${root}/app/globals.css`] = `body {
  font-family: system-ui, sans-serif;
  display: grid;
  place-items: center;
  min-height: 100vh;
  margin: 0;
}
main { text-align: center; }
button { font-size: 1em; padding: 0.6em 1.2em; cursor: pointer; }
.hint { color: #666; }
`;

	return files;
}
