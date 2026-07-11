import { type ReactNode, useState } from 'react';
import { Info } from 'lucide-react';

interface ExamplePanelProps {
  title: string;
  subtitle?: ReactNode;
  children: ReactNode;
  /** Optional control rendered in the header, left of the info toggle (e.g. the
   *  terminal fold/unfold button for preview examples). */
  headerAction?: ReactNode;
}

/**
 * Compact output-panel chrome (VS Code-like): a full-width navbar with the
 * example body flush beneath it. The description is collapsed by default
 * (info toggle). The example's code sample shows up as a "README.md" tab in
 * the terminal area, not here.
 */
export function ExamplePanel({ title, subtitle, children, headerAction }: ExamplePanelProps) {
  const [showDesc, setShowDesc] = useState(false);

  return (
    <div className="flex flex-col flex-1 min-h-0">
      {/* Navbar — end to end. */}
      <div className="flex items-center gap-1.5 h-9 px-3 border-b border-tokyo-border bg-tokyo-bg-dark shrink-0">
        <span className="text-[13px] font-semibold text-tokyo-fg-bright truncate">{title}</span>
        <div className="ml-auto flex items-center gap-0.5 shrink-0">
          {headerAction}
          {subtitle && (
            <button
              onClick={() => setShowDesc((v) => !v)}
              title="About this example"
              className={
                'w-6 h-6 grid place-items-center rounded bg-transparent border-none cursor-pointer ' +
                (showDesc ? 'text-tokyo-blue' : 'text-tokyo-comment hover:text-tokyo-fg-bright hover:bg-tokyo-hover')
              }
            >
              <Info size={14} />
            </button>
          )}
        </div>
      </div>
      {subtitle && showDesc && (
        <div className="text-[11px] text-tokyo-comment leading-relaxed px-3 py-2 border-b border-tokyo-border bg-tokyo-bg-dark shrink-0">
          {subtitle}
        </div>
      )}

      <div className="flex-1 min-h-0 flex flex-col">{children}</div>
    </div>
  );
}
