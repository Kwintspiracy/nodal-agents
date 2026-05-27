/**
 * SetPane — read-only key/value pane used in Settings sections.
 * Paper bg, rule-2 border, 12px radius. Children should be <SetRow> elements.
 */
export function SetPane({ children }: { children: React.ReactNode }) {
  return (
    <div className="mt-3.5 bg-neutral-900 border border-neutral-800/60 rounded-xl overflow-hidden">
      {children}
    </div>
  );
}
