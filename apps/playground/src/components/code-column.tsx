interface CodeColumnProps {
  snippet?: string;
}

/**
 * The "Code" column — a pre-highlighted HTML snippet for the active example.
 * The code block's dark background fills the whole column (flush, no card), and
 * the app-shell's border separates it from the sidebar/output.
 */
export function CodeColumn({ snippet }: CodeColumnProps) {
  return (
    <div className="h-full min-h-0 overflow-auto bg-tokyo-bg-dark">
      <div
        className="px-4 py-3 font-code text-xs leading-relaxed whitespace-pre text-tokyo-fg"
        dangerouslySetInnerHTML={{ __html: snippet ?? '' }}
      />
    </div>
  );
}
