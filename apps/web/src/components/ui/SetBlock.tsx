/**
 * SetBlock — wraps a settings section.
 * Renders a mono uppercase label, optional lede description, and children.
 * Handles all spacing so callers don't repeat margins.
 */
export function SetBlock({
  label,
  lede,
  children,
}: {
  label: string;
  lede?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="mt-7">
      <div className="font-mono text-[10.5px] tracking-[0.18em] uppercase text-ink-4">{label}</div>
      {lede && <p className="text-[13px] leading-[1.5] text-ink-3 mt-1.5">{lede}</p>}
      {children}
    </section>
  );
}
