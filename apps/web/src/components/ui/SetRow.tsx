/**
 * SetRow — flex row inside a SetPane.
 * `label` is the .k column; `sub` is an optional secondary description under the label.
 * Children populate the .v (value) slot.
 */
export function SetRow({
  label,
  sub,
  children,
}: {
  label: string;
  sub?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-3.5 px-[18px] py-3.5 border-b border-rule-2 last:border-b-0 text-[13.5px] leading-[1.4] text-ink-2">
      <span className="flex-1 min-w-0 text-ink-2">
        {label}
        {sub && <span className="block text-xs text-ink-4 mt-0.5">{sub}</span>}
      </span>
      <span className="inline-flex items-center gap-2 text-[13px] text-ink-2 shrink-0">
        {children}
      </span>
    </div>
  );
}
