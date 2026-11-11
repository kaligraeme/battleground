/** The Battleground mark: two opposing chevrons (blue team, red team) inside an arena. */
export function BrandMark({ size = 24 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M12 2.2 20.5 7v10L12 21.8 3.5 17V7z" stroke="var(--text-3)" strokeWidth="1.5" />
      <path d="m7.9 9.3 2.7 2.7-2.7 2.7" stroke="var(--accent)" strokeWidth="2" />
      <path d="m16.1 9.3-2.7 2.7 2.7 2.7" stroke="var(--err)" strokeWidth="2" />
    </svg>
  );
}

export function Brand() {
  return (
    <div className="brand">
      <BrandMark />
      <span className="brand__name">Battleground</span>
    </div>
  );
}
