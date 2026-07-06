import { lazy, type ComponentType } from 'react';
import { codeSnippets } from '@/data/code-snippets';

// Each example is code-split: its module (and any heavy deps — Monaco, VFS
// templates) loads only when the example is first activated.
const GitExample = lazy(() => import('@/examples/git'));
const InteractiveExample = lazy(() => import('@/examples/interactive'));
const HeadlessExample = lazy(() => import('@/examples/headless'));
const MultiExample = lazy(() => import('@/examples/multi'));
const HttpExample = lazy(() => import('@/examples/http'));
const NpmExample = lazy(() => import('@/examples/npm'));
const ExplorerExample = lazy(() => import('@/examples/explorer'));
const FfmpegExample = lazy(() => import('@/examples/ffmpeg'));
const ViteReactExample = lazy(() => import('@/examples/vite-react'));
const ViteReactTsExample = lazy(() => import('@/examples/vite-react-ts'));
const CreateViteExample = lazy(() => import('@/examples/create-vite'));
const TinbaseExample = lazy(() => import('@/examples/tinbase'));
const PgliteExample = lazy(() => import('@/examples/pglite'));
const ExpoExample = lazy(() => import('@/examples/expo'));
const ExpoRouterExample = lazy(() => import('@/examples/expo-router'));
const CliExample = lazy(() => import('@/examples/cli'));
const LifoPkgExample = lazy(() => import('@/examples/lifo-pkg'));
const BuildPkgExample = lazy(() => import('@/examples/build-pkg'));

export type ExampleGroup = 'Examples' | 'Real-World Stacks' | 'Installable Packages' | 'Develop';

export interface ExampleConfig {
  id: string;
  label: string;
  group: ExampleGroup;
  /** Hide the Code column for docs-style examples (cli/lifo-pkg/build-pkg). */
  hideCode?: boolean;
  Component: ComponentType;
}

export const examples: ExampleConfig[] = [
  // ── Examples ──
  { id: 'interactive', label: 'Interactive Shell', group: 'Examples', Component: InteractiveExample },
  { id: 'headless', label: 'Headless / AI Agent', group: 'Examples', Component: HeadlessExample },
  { id: 'multi', label: 'Multi Terminal', group: 'Examples', Component: MultiExample },
  { id: 'http', label: 'HTTP Server', group: 'Examples', Component: HttpExample },
  { id: 'explorer', label: 'File Explorer', group: 'Examples', Component: ExplorerExample },
  { id: 'npm', label: 'npm', group: 'Examples', Component: NpmExample },
  { id: 'cli', label: 'CLI (Node.js)', group: 'Examples', hideCode: true, Component: CliExample },
  // ── Real-World Stacks ──
  { id: 'vite-react', label: 'Vite with React', group: 'Real-World Stacks', Component: ViteReactExample },
  { id: 'vite-react-ts', label: 'Vite with React + TS', group: 'Real-World Stacks', Component: ViteReactTsExample },
  { id: 'create-vite', label: 'create-vite (1:1)', group: 'Real-World Stacks', Component: CreateViteExample },
  { id: 'tinbase', label: 'Supabase Todo (tinbase)', group: 'Real-World Stacks', Component: TinbaseExample },
  { id: 'pglite', label: 'Postgres (PGlite)', group: 'Real-World Stacks', Component: PgliteExample },
  { id: 'expo', label: 'Expo (React Native Web)', group: 'Real-World Stacks', Component: ExpoExample },
  { id: 'expo-router', label: 'Expo Router', group: 'Real-World Stacks', Component: ExpoRouterExample },
  // ── Installable Packages ──
  { id: 'git', label: 'Git', group: 'Installable Packages', Component: GitExample },
  { id: 'ffmpeg', label: 'FFmpeg', group: 'Installable Packages', Component: FfmpegExample },
  // ── Develop ──
  { id: 'lifo-pkg', label: 'Lifo Package Manager', group: 'Develop', hideCode: true, Component: LifoPkgExample },
  { id: 'build-pkg', label: 'Build Lifo Packages', group: 'Develop', hideCode: true, Component: BuildPkgExample },
];

export const exampleGroups: ExampleGroup[] = ['Examples', 'Real-World Stacks', 'Installable Packages', 'Develop'];

export function findExample(id: string): ExampleConfig {
  return examples.find((e) => e.id === id) ?? examples[0];
}

export function snippetFor(id: string): string | undefined {
  return codeSnippets[id];
}
