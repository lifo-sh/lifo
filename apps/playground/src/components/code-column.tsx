interface CodeColumnProps {
  snippet?: string;
}

/** The "Code" column — renders a pre-highlighted HTML snippet for the active example. */
export function CodeColumn({ snippet }: CodeColumnProps) {
  return (
    <div className="flex flex-col h-full min-h-0 overflow-hidden">
      <div className="px-4 py-2.5 border-b border-tokyo-border shrink-0">
        <div className="text-[10px] font-semibold uppercase tracking-widest text-tokyo-comment">Code</div>
      </div>
      <div className="flex-1 p-4 overflow-y-auto">
        <div
          className="bg-tokyo-bg-dark border border-tokyo-border rounded-md px-4 py-3.5 font-code text-xs leading-relaxed whitespace-pre overflow-x-auto text-tokyo-fg"
          dangerouslySetInnerHTML={{ __html: snippet ?? '' }}
        />
      </div>
    </div>
  );
}
