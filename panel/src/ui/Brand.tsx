/** Three hops from one source: the picture of what the hub does (a request in, routed out, with a fallback). */
export function BrandMark({ className = 'brand-mark' }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 32 32" aria-hidden="true">
      <rect width="32" height="32" rx="7" fill="var(--ink)" />
      <circle cx="8" cy="16" r="3.2" fill="var(--local-line)" />
      <path d="M11 16h6m0 0 4-6h4M17 16h8M17 16l4 6h4" stroke="var(--cloud-line)" strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
