import { ExamplePanel } from '@/components/example-panel';

interface DocsViewProps {
  title: string;
  /** Pre-formatted, self-styled HTML (inline color spans) shown in a scrollable block. */
  html: string;
}

/** Docs-style example: a scrollable monospace block of pre-highlighted HTML (no code column). */
export function DocsView({ title, html }: DocsViewProps) {
  return (
    <ExamplePanel title={title}>
      <div className="flex-1 min-h-0 overflow-auto rounded-lg border border-tokyo-border bg-tokyo-bg p-4">
        <pre
          className="font-code text-[13px] leading-relaxed whitespace-pre text-tokyo-fg"
          dangerouslySetInnerHTML={{ __html: html }}
        />
      </div>
    </ExamplePanel>
  );
}
