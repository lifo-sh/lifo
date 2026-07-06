import type { ComponentType } from 'react';
import { codeSnippets } from '@/data/code-snippets';
import GitExample from '@/examples/git';
import InteractiveExample from '@/examples/interactive';
import HeadlessExample from '@/examples/headless';
import MultiExample from '@/examples/multi';
import HttpExample from '@/examples/http';
import NpmExample from '@/examples/npm';

export type ExampleGroup = 'Examples' | 'Real-World Stacks' | 'Installable Packages' | 'Develop';

export interface ExampleConfig {
  id: string;
  label: string;
  group: ExampleGroup;
  /** Hide the Code column for docs-style examples (cli/lifo-pkg/build-pkg). */
  hideCode?: boolean;
  Component: ComponentType;
}

/** Placeholder for examples not yet ported (removed as each phase lands). */
function comingSoon(id: string): ComponentType {
  const Stub = () => (
    <div className="flex flex-1 items-center justify-center text-tokyo-comment text-sm">
      "{id}" — not ported to React yet.
    </div>
  );
  Stub.displayName = `ComingSoon(${id})`;
  return Stub;
}

export const examples: ExampleConfig[] = [
  // ── Examples ──
  { id: 'interactive', label: 'Interactive Shell', group: 'Examples', Component: InteractiveExample },
  { id: 'headless', label: 'Headless / AI Agent', group: 'Examples', Component: HeadlessExample },
  { id: 'multi', label: 'Multi Terminal', group: 'Examples', Component: MultiExample },
  { id: 'http', label: 'HTTP Server', group: 'Examples', Component: HttpExample },
  { id: 'explorer', label: 'File Explorer', group: 'Examples', Component: comingSoon('explorer') },
  { id: 'npm', label: 'npm', group: 'Examples', Component: NpmExample },
  { id: 'cli', label: 'CLI (Node.js)', group: 'Examples', hideCode: true, Component: comingSoon('cli') },
  // ── Real-World Stacks ──
  { id: 'vite-react', label: 'Vite with React', group: 'Real-World Stacks', Component: comingSoon('vite-react') },
  { id: 'vite-react-ts', label: 'Vite with React + TS', group: 'Real-World Stacks', Component: comingSoon('vite-react-ts') },
  { id: 'create-vite', label: 'create-vite (1:1)', group: 'Real-World Stacks', Component: comingSoon('create-vite') },
  { id: 'tinbase', label: 'Supabase Todo (tinbase)', group: 'Real-World Stacks', Component: comingSoon('tinbase') },
  { id: 'pglite', label: 'Postgres (PGlite)', group: 'Real-World Stacks', Component: comingSoon('pglite') },
  { id: 'expo', label: 'Expo (React Native Web)', group: 'Real-World Stacks', Component: comingSoon('expo') },
  { id: 'expo-router', label: 'Expo Router', group: 'Real-World Stacks', Component: comingSoon('expo-router') },
  // ── Installable Packages ──
  { id: 'git', label: 'Git', group: 'Installable Packages', Component: GitExample },
  { id: 'ffmpeg', label: 'FFmpeg', group: 'Installable Packages', Component: comingSoon('ffmpeg') },
  // ── Develop ──
  { id: 'lifo-pkg', label: 'Lifo Package Manager', group: 'Develop', hideCode: true, Component: comingSoon('lifo-pkg') },
  { id: 'build-pkg', label: 'Build Lifo Packages', group: 'Develop', hideCode: true, Component: comingSoon('build-pkg') },
];

export const exampleGroups: ExampleGroup[] = ['Examples', 'Real-World Stacks', 'Installable Packages', 'Develop'];

export function findExample(id: string): ExampleConfig {
  return examples.find((e) => e.id === id) ?? examples[0];
}

export function snippetFor(id: string): string | undefined {
  return codeSnippets[id];
}
