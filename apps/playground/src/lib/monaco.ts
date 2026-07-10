import type { EditorProvider, EditorInstance } from '@lifo-sh/ui';
import type { ThemeMode } from '@/lib/theme';

declare global {
  interface Window {
    MonacoEnvironment?: { getWorker(workerId: string, label: string): Worker };
  }
}

// Monaco's theme is global (monaco.editor.setTheme affects every editor), so we
// track the desired mode at module scope and switch all editors at once.
let currentMode: ThemeMode = 'dark';
let workersConfigured = false;
let themesDefined = false;

type Monaco = typeof import('monaco-editor');

function configure(monaco: Monaco) {
  if (!workersConfigured) {
    workersConfigured = true;
    window.MonacoEnvironment = {
      getWorker(_workerId: string, label: string) {
        if (label === 'json') {
          return new Worker(new URL('monaco-editor/esm/vs/language/json/json.worker.js', import.meta.url), { type: 'module' });
        }
        if (label === 'css' || label === 'scss' || label === 'less') {
          return new Worker(new URL('monaco-editor/esm/vs/language/css/css.worker.js', import.meta.url), { type: 'module' });
        }
        if (label === 'html' || label === 'handlebars' || label === 'razor') {
          return new Worker(new URL('monaco-editor/esm/vs/language/html/html.worker.js', import.meta.url), { type: 'module' });
        }
        if (label === 'typescript' || label === 'javascript') {
          return new Worker(new URL('monaco-editor/esm/vs/language/typescript/ts.worker.js', import.meta.url), { type: 'module' });
        }
        return new Worker(new URL('monaco-editor/esm/vs/editor/editor.worker.js', import.meta.url), { type: 'module' });
      },
    };
  }
  if (!themesDefined) {
    themesDefined = true;
    // Tokyo Night (dark)
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
    // Tokyo Night Day (light)
    monaco.editor.defineTheme('tokyo-day', {
      base: 'vs',
      inherit: true,
      rules: [
        { token: 'comment', foreground: '848cb5', fontStyle: 'italic' },
        { token: 'keyword', foreground: '9854f1' },
        { token: 'string', foreground: '587539' },
        { token: 'number', foreground: 'b15c00' },
        { token: 'type', foreground: '007197' },
        { token: 'identifier', foreground: '343b58' },
        { token: 'delimiter', foreground: '006a83' },
      ],
      colors: {
        'editor.background': '#e1e2e7',
        'editor.foreground': '#3760bf',
        'editor.selectionBackground': '#b6bfe2',
        'editor.lineHighlightBackground': '#d8dae2',
        'editorCursor.foreground': '#343b58',
        'editorLineNumber.foreground': '#a1a6c5',
        'editorLineNumber.activeForeground': '#343b58',
      },
    });
  }
}

const themeName = (mode: ThemeMode) => (mode === 'light' ? 'tokyo-day' : 'tokyo-night');

/** Switch every Monaco editor to the light/dark theme. Safe to call anytime. */
export function setMonacoTheme(mode: ThemeMode): void {
  currentMode = mode;
  void import('monaco-editor').then((monaco) => {
    configure(monaco);
    monaco.editor.setTheme(themeName(mode));
  });
}

/* Monaco editor provider (module workers + theme-aware). */
export function createMonacoProvider(): EditorProvider {
  return {
    create(container: HTMLElement, content: string, language: string): EditorInstance {
      let editor: import('monaco-editor').editor.IStandaloneCodeEditor | null = null;
      let disposed = false;
      const changeCallbacks: (() => void)[] = [];

      import('monaco-editor').then((monaco) => {
        if (disposed) return;
        configure(monaco);

        editor = monaco.editor.create(container, {
          value: content,
          language,
          theme: themeName(currentMode),
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
