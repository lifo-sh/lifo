/**
 * Vite + React VFS seed files. `vite: 8` is the current stack (Vite 8, React 19, plugin-react 6):
 * Rolldown needs WebAssembly threads, so those examples run their box in a Web Worker. `vite: 7`
 * (React 18) runs in a box on the page, as the Interactive example's seed does.
 */
export function viteReactAppFiles(root: string, ts: boolean, vite: 7 | 8 = 7): Record<string, string> {
	const x = ts ? 'tsx' : 'jsx';
	const files: Record<string, string> = {};

	files[`${root}/package.json`] = JSON.stringify({
		name: root.split('/').pop(),
		version: '1.0.0',
		type: 'module',
		scripts: { dev: 'vite', build: 'vite build' },
		dependencies: vite === 8
			? {
				react: '^19.3.1',
				'react-dom': '^19.3.1',
				vite: '^8.4.0',
				'@vitejs/plugin-react': '^6.3.0',
				// TypeScript 5 (JavaScript) rather than create-vite's 7: TypeScript 7 is a native
				// binary, so `npx tsc` couldn't run in the box.
				...(ts ? { typescript: '~5.9.3', '@types/react': '^19.3.0', '@types/react-dom': '^19.3.0' } : {}),
			}
			: {
				react: '^18.3.1',
				'react-dom': '^18.3.1',
				vite: '^7.3.1',
				'@vitejs/plugin-react': '^5.0.0',
				...(ts ? { typescript: '~5.9.3', '@types/react': '^18.3.12', '@types/react-dom': '^18.3.1' } : {}),
			},
	}, null, 2);

	// Stock Vite config — identical in shape to what create-vite scaffolds.
	files[`${root}/vite.config.js`] = `import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
})
`;

	files[`${root}/index.html`] = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>React in Lifo</title>
</head>
<body>
  <div id="root"></div>
  <script type="module" src="/src/main.${x}"></script>
</body>
</html>`;

	files[`${root}/src/main.${x}`] = `import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.${x}';

createRoot(document.getElementById('root')${ts ? '!' : ''}).render(<App />);
`;

	files[`${root}/src/App.${x}`] = `import { useState } from 'react';

export default function App() {
  const [count, setCount] = useState${ts ? '<number>' : ''}(0);
  return (
    <div style={{ fontFamily: 'system-ui', textAlign: 'center', marginTop: '4rem' }}>
      <h1>React inside Lifo 🚀</h1>
      <p>This React app is served by a Vite dev server running in your browser${ts ? ' — in TypeScript' : ''}.</p>
      <button onClick={() => setCount(count + 1)} style={{ padding: '0.6em 1.2em', fontSize: '1em' }}>
        count is {count}
      </button>
    </div>
  );
}
`;

	if (ts) {
		files[`${root}/tsconfig.json`] = JSON.stringify({
			compilerOptions: {
				target: 'ES2022',
				module: 'ESNext',
				moduleResolution: 'bundler',
				jsx: 'react-jsx',
				strict: true,
				noEmit: true,
				lib: ['ES2022', 'DOM', 'DOM.Iterable'],
			},
			include: ['src'],
		}, null, 2);
	}

	return files;
}
