import type { ReactNode } from 'react';

/**
 * SidebarSection — mono uppercase section label inside the nav.
 * Matches `.side-section` in the design bundle.
 */
export default function SidebarSection({ children }: { children: ReactNode }) {
  return (
    <div className="px-3.5 pt-4 pb-1.5 font-mono text-[11px] uppercase tracking-[0.14em] text-ink-4 lg:pt-3.5 lg:pb-1 lg:text-[11px]">
      {children}
    </div>
  );
}
