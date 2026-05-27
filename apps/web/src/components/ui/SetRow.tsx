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
    <div className="flex items-center gap-3.5 px-[18px] py-3.5 border-b border-neutral-800/60 last:border-b-0 text-[13.5px] leading-[1.4] text-neutral-300">
      <span className="flex-1 min-w-0 text-neutral-300">
        {label}
        {sub && <span className="block text-xs text-neutral-500 mt-0.5">{sub}</span>}
      </span>
      <span className="inline-flex items-center gap-2 text-[13px] text-neutral-300 shrink-0">
        {children}
      </span>
    </div>
  );
}
