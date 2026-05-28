/**
 * CheckOk — lime-coloured check icon + text for "configured" / positive status.
 * Mirrors the design's `.ck-ok` pattern.
 */
export function CheckOk({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-lime-400 font-medium">
      <svg
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        className="w-[13px] h-[13px] flex-shrink-0"
      >
        <path d="M3.5 8.5l3 3 6-6" />
      </svg>
      {children}
    </span>
  );
}
