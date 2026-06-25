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
    <div className="mt-3.5 bg-paper border border-rule-2 rounded-[14px] p-5">
      {label && <div className="text-[14px] leading-none text-ink-3 mb-2.5">{label}</div>}
      {children}
    </div>
  );
}
