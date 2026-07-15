/** Lifo mark — a terminal prompt: a green chevron + a green cursor block. */
export function LifoLogo({ className = 'size-6' }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true">
      <rect x="0.75" y="0.75" width="22.5" height="22.5" rx="5.25" fill="#16161e" stroke="#292e42" />
      <path
        d="M6.5 8.5 L10 12 L6.5 15.5"
        fill="none"
        stroke="#9ece6a"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <rect x="12.5" y="13.8" width="5.5" height="2.2" rx="1" fill="#9ece6a" />
    </svg>
  );
}
