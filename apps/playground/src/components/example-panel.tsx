import type { ReactNode } from 'react';

interface ExamplePanelProps {
  title: string;
  subtitle?: ReactNode;
  children: ReactNode;
}

/** Standard output-panel chrome: a title + description over the example body. */
export function ExamplePanel({ title, subtitle, children }: ExamplePanelProps) {
  return (
    <div className="flex flex-col flex-1 min-h-0">
      <div className="text-[13px] font-semibold text-tokyo-fg-bright mb-0.5">{title}</div>
      {subtitle ? <div className="text-[11px] text-tokyo-comment mb-3.5">{subtitle}</div> : null}
      {children}
    </div>
  );
}
