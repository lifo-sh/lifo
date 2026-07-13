import { lazy, type ComponentType } from 'react';
import { codeSnippets } from '@/data/code-snippets';

// Each example is code-split: its module (and any heavy deps — Monaco, VFS
// templates) loads only when the example is first activated.
const GitExample = lazy(() => import('@/examples/git'));
const InteractiveExample = lazy(() => import('@/examples/interactive'));
const HeadlessExample = lazy(() => import('@/examples/headless'));
const HttpExample = lazy(() => import('@/examples/http'));
const ExpressExample = lazy(() => import('@/examples/express'));
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
const CreateExpoAppExample = lazy(() => import('@/examples/create-expo-app'));
const BrowserMetroExample = lazy(() => import('@/examples/browser-metro'));
const ExpoSupabaseExample = lazy(() => import('@/examples/expo-supabase'));
const CliExample = lazy(() => import('@/examples/cli'));
const LifoPkgExample = lazy(() => import('@/examples/lifo-pkg'));
const BuildPkgExample = lazy(() => import('@/examples/build-pkg'));

export type ExampleGroup = 'Examples' | 'Real-World Stacks' | 'Installable Packages' | 'Develop';

export interface ExampleConfig {
  id: string;
  label: string;
  group: ExampleGroup;
  /** Optional collapsible sub-section within a group (e.g. Real-World Stacks). */
  subgroup?: string;
  /** Hide the Code column for docs-style examples (cli/lifo-pkg/build-pkg). */
  hideCode?: boolean;
  Component: ComponentType;
}

export const examples: ExampleConfig[] = [
  // ── Examples ──
  { id: 'interactive', label: 'Interactive Shell', group: 'Examples', Component: InteractiveExample },
  { id: 'headless', label: 'Headless / AI Agent', group: 'Examples', Component: HeadlessExample },
  { id: 'http', label: 'HTTP Server', group: 'Examples', Component: HttpExample },
  { id: 'explorer', label: 'File Explorer', group: 'Examples', Component: ExplorerExample },
  { id: 'npm', label: 'npm', group: 'Examples', Component: NpmExample },
  { id: 'cli', label: 'CLI (Node.js)', group: 'Examples', hideCode: true, Component: CliExample },
  // ── Real-World Stacks ──
  { id: 'vite-react', label: 'Vite with React', group: 'Real-World Stacks', subgroup: 'Frontend', Component: ViteReactExample },
  { id: 'vite-react-ts', label: 'Vite with React + TS', group: 'Real-World Stacks', subgroup: 'Frontend', Component: ViteReactTsExample },
  { id: 'create-vite', label: 'create-vite (1:1)', group: 'Real-World Stacks', subgroup: 'Frontend', Component: CreateViteExample },
  { id: 'express', label: 'Node.js + Express', group: 'Real-World Stacks', subgroup: 'Backend & Data', Component: ExpressExample },
  { id: 'tinbase', label: 'Supabase (tinbase)', group: 'Real-World Stacks', subgroup: 'Backend & Data', Component: TinbaseExample },
  { id: 'pglite', label: 'Postgres (PGlite)', group: 'Real-World Stacks', subgroup: 'Backend & Data', Component: PgliteExample },
  { id: 'expo', label: 'Expo (React Native Web)', group: 'Real-World Stacks', subgroup: 'Mobile (Expo)', Component: ExpoExample },
  { id: 'expo-router', label: 'Expo Router', group: 'Real-World Stacks', subgroup: 'Mobile (Expo)', Component: ExpoRouterExample },
  { id: 'create-expo-app', label: 'create-expo-app (1:1)', group: 'Real-World Stacks', subgroup: 'Mobile (Expo)', Component: CreateExpoAppExample },
  { id: 'browser-metro', label: 'browser-metro (light)', group: 'Real-World Stacks', subgroup: 'Mobile (Expo)', Component: BrowserMetroExample },
  { id: 'expo-supabase', label: 'Expo Router + Supabase', group: 'Real-World Stacks', subgroup: 'Mobile (Expo)', Component: ExpoSupabaseExample },
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

/** Examples in a group, keyed by subgroup (in first-seen order). The `''` key
 *  holds items with no subgroup (rendered directly, before any subgroups). */
export function sectionsFor(group: ExampleGroup): { subgroup: string; items: ExampleConfig[] }[] {
  const order: string[] = [];
  const byKey = new Map<string, ExampleConfig[]>();
  for (const e of examples) {
    if (e.group !== group) continue;
    const key = e.subgroup ?? '';
    if (!byKey.has(key)) { byKey.set(key, []); order.push(key); }
    byKey.get(key)!.push(e);
  }
  return order.map((subgroup) => ({ subgroup, items: byKey.get(subgroup)! }));
}
