/**
 * BrandMark — sidebar identity block.
 *
 *   ┌──┐
 *   │N │  Nodal
 *   └──┘  AGENT FLEETS
 *
 * Per the design bundle: square ink-coloured "N" pastille (auto-inverts in
 * dark mode because both the bg and contrast colour switch with data-theme),
 * the "Nodal" wordmark, and a small mono uppercase subtitle.
 */
export default function BrandMark({ subtitle = 'Agent fleets' }: { subtitle?: string }) {
  return (
    <div className="px-4 pb-3.5">
      <div className="flex items-center gap-2 text-[16px] font-medium leading-none tracking-[-0.005em] text-ink">
        <span className="flex h-[22px] w-[22px] items-center justify-center rounded-md bg-ink text-[11px] font-semibold leading-none tracking-[0.04em] text-canvas font-mono">
          N
        </span>
        <span>Nodal</span>
      </div>
      <div className="mt-1.5 pl-[30px] font-mono text-[9.5px] uppercase tracking-[0.14em] text-ink-4">
        {subtitle}
      </div>
    </div>
  );
}
