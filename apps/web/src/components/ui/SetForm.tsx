/**
 * SetForm — editable settings form pane (paper bg, rule-2 border, 14px radius, 20px padding).
 * Wraps OptionRadio cards, Banners, SetMini rows, and SetCtaRow.
 */
export function SetForm({
  label,
  children,
}: {
  /** Sub-label rendered above the radio cards (e.g. "Auth mode"). */
  label?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="mt-3.5 bg-neutral-900 border border-neutral-800/60 rounded-[14px] p-5">
      {label && <div className="text-[13px] leading-none text-neutral-400 mb-2.5">{label}</div>}
      {children}
    </div>
  );
}
