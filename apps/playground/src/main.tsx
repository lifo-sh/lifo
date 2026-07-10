import './app.css';
import '@xterm/xterm/css/xterm.css';
import { createRoot } from 'react-dom/client';
import { App } from '@/components/app-shell';
import { ThemeProvider } from '@/lib/theme';

// No StrictMode: the imperative Kernel/Terminal/Sandbox/ServiceWorkerBridge are
// non-idempotent (async boot, no dispose, global SW), so a dev double-invoke
// would boot duplicates. Effects are still guarded individually.
createRoot(document.getElementById('root')!).render(
  <ThemeProvider>
    <App />
  </ThemeProvider>,
);
