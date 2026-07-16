/**
 * BrandMark — sidebar identity block.
 *
 *   ┌──┐
 *   │N │  Nodal-Agents
 *   └──┘
 *
 * Per the design bundle: square ink-coloured "N" pastille (auto-inverts in
 * dark mode because both the bg and contrast colour switch with data-theme)
 * alongside the "Nodal-Agents" wordmark on a single line.
 */
export default function BrandMark() {
  return (
    <div className="px-4 pb-3.5">
      <div className="flex items-center gap-2 text-legacy-16 font-medium leading-none! tracking-[-0.005em] text-ink">
        <span className="flex h-[22px] w-[22px] items-center justify-center rounded-md bg-ink text-legacy-12 font-semibold leading-none! tracking-[0.04em] text-canvas font-mono">
          N
        </span>
        <span>Nodal-Agents</span>
      </div>
    </div>
  );
}
