// ─── Section card wrapper ────────────────────────────────────────────────────
//
// The card + head every section of the agent editor is built from. They lived
// inside AgentComposer.tsx, private to it, which meant a section extracted to
// its own file (CommandAllowlistSection.tsx, issue #131) had to either import
// the 4000-line composer just to draw a card, or copy its classes and let the
// two drift. Moved here unchanged: same markup, same tokens, one definition.

export function SectionCard({ children }: { children: React.ReactNode }) {
  return <div className="rounded-2xl border border-rule-2 bg-paper p-6">{children}</div>;
}

export function SectionHead({
  label,
  hint,
  right,
}: {
  label: string;
  hint?: string;
  right?: React.ReactNode;
}) {
  return (
    <div className="mb-4 flex items-start justify-between gap-4">
      <div>
        <div className="text-mono-11 uppercase tracking-[0.12em] text-ink-4">{label}</div>
        {hint && <p className="mt-1 text-body-13 leading-[1.5]! text-ink-3">{hint}</p>}
      </div>
      {right}
    </div>
  );
}
