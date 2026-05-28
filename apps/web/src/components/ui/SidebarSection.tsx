import type { ReactNode } from 'react';

/**
 * SidebarSection — mono uppercase section label inside the nav.
 * Matches `.side-section` in the design bundle.
 */
export default function SidebarSection({ children }: { children: ReactNode }) {
  return (
    <div className="px-3.5 pt-3.5 pb-1 font-mono text-[9.5px] uppercase tracking-[0.14em] text-ink-4">
      {children}
    </div>
  );
}
