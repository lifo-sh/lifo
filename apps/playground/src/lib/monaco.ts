import type { EditorProvider, EditorInstance } from '@lifo-sh/ui';

declare global {
  interface Window {
    MonacoEnvironment?: { getWorker(workerId: string, label: string): Worker };
  }
}

/* Monaco editor provider (module workers + Tokyo Night theme), moved verbatim from the old main.ts. */
export function createMonacoProvider(): EditorProvider {
	return {
		create(container: HTMLElement, content: string, language: string): EditorInstance {
			// Lazy-load Monaco
			let editor: import('monaco-editor').editor.IStandaloneCodeEditor | null = null;
			let disposed = false;
			const changeCallbacks: (() => void)[] = [];

			import('monaco-editor').then((monaco) => {
				if (disposed) return;

				// Configure Monaco workers
				window.MonacoEnvironment = {
					getWorker(_workerId: string, label: string) {
						if (label === 'json') {
							return new Worker(
								new URL('monaco-editor/esm/vs/language/json/json.worker.js', import.meta.url),
								{ type: 'module' },
							);
						}
						if (label === 'css' || label === 'scss' || label === 'less') {
							return new Worker(
								new URL('monaco-editor/esm/vs/language/css/css.worker.js', import.meta.url),
								{ type: 'module' },
							);
						}
						if (label === 'html' || label === 'handlebars' || label === 'razor') {
							return new Worker(
								new URL('monaco-editor/esm/vs/language/html/html.worker.js', import.meta.url),
								{ type: 'module' },
							);
						}
						if (label === 'typescript' || label === 'javascript') {
							return new Worker(
								new URL('monaco-editor/esm/vs/language/typescript/ts.worker.js', import.meta.url),
								{ type: 'module' },
							);
						}
						return new Worker(
							new URL('monaco-editor/esm/vs/editor/editor.worker.js', import.meta.url),
							{ type: 'module' },
						);
					},
				};

				// Define Tokyo Night theme
				monaco.editor.defineTheme('tokyo-night', {
					base: 'vs-dark',
					inherit: true,
					rules: [
						{ token: 'comment', foreground: '565f89', fontStyle: 'italic' },
						{ token: 'keyword', foreground: 'bb9af7' },
						{ token: 'string', foreground: '9ece6a' },
						{ token: 'number', foreground: 'ff9e64' },
						{ token: 'type', foreground: '2ac3de' },
						{ token: 'identifier', foreground: 'c0caf5' },
						{ token: 'delimiter', foreground: '89ddff' },
					],
					colors: {
						'editor.background': '#1a1b26',
						'editor.foreground': '#a9b1d6',
						'editor.selectionBackground': '#33467c',
						'editor.lineHighlightBackground': '#1e2030',
						'editorCursor.foreground': '#c0caf5',
						'editorLineNumber.foreground': '#3b4261',
						'editorLineNumber.activeForeground': '#737aa2',
					},
				});

				editor = monaco.editor.create(container, {
					value: content,
					language,
					theme: 'tokyo-night',
					fontSize: 13,
					fontFamily: '"Cascadia Code", "Fira Code", "JetBrains Mono", Menlo, monospace',
					lineHeight: 20,
					minimap: { enabled: false },
					scrollBeyondLastLine: false,
					automaticLayout: true,
					padding: { top: 8, bottom: 8 },
					renderLineHighlight: 'line',
					overviewRulerLanes: 0,
					hideCursorInOverviewRuler: true,
					overviewRulerBorder: false,
					scrollbar: {
						verticalScrollbarSize: 6,
						horizontalScrollbarSize: 6,
					},
				});

				editor.onDidChangeModelContent(() => {
					for (const cb of changeCallbacks) cb();
				});
			});

			return {
				getValue(): string {
					return editor?.getValue() ?? content;
				},
				onDidChangeContent(callback: () => void): void {
					changeCallbacks.push(callback);
				},
				dispose(): void {
					disposed = true;
					editor?.dispose();
					editor = null;
				},
			};
		},
	};
}
