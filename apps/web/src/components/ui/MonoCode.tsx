/**
 * MonoCode — inline monospaced code pill (hover-bg, rounded).
 * Used for displaying mode strings, URLs, commands inline.
 */
export function MonoCode({ children }: { children: React.ReactNode }) {
  return (
    <code className="font-mono text-[12.5px] bg-neutral-800 rounded-[5px] px-2 py-[5px] text-neutral-200 tracking-[0.02em]">
      {children}
    </code>
  );
}
