/**
 * The mark: a hub that merges clients and several providers into one universal API. The top branch is the local node,
 * which has its own logic, so it takes the local line colour; it is drawn first so the cloud branches cover the shared
 * junction. public/favicon.svg is the same drawing with fixed colours.
 */
export function BrandMark({ className = 'brand-mark' }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 32 32" aria-hidden="true">
      <rect width="32" height="32" rx="7" fill="var(--ink)" />
      <circle cx="8" cy="16" r="3.2" fill="var(--local-line)" />
      <g fill="none" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M17 16l4-6h4" stroke="var(--local-line)" />
        <path d="M11 16h14M17 16l4 6h4" stroke="var(--cloud-line)" />
      </g>
    </svg>
  );
}
