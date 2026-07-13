'use client';

import type { ReactNode } from 'react';

type Props = {
  open: boolean;
  onClick: () => void;
  /** Rich row content next to the chevron — name, badges, trailing meta. No
   *  nested interactive elements (real <button> can't contain one); rows that
   *  need a nested action (e.g. a delete icon) should use the div[role="button"]
   *  pattern instead (see ChatClient's ConversationRow / MemoriesClient's
   *  MemoryFact). */
  children: ReactNode;
  className?: string;
};

/**
 * DisclosureButton — full-width accordion trigger: chevron + arbitrary
 * content, toggling `aria-expanded`. A real <button> (native keyboard/focus
 * behaviour for free), so it's only for rows whose content has no nested
 * interactive element of its own — promoted from RootContextClient's skill
 * list (DS Phase 2R) instead of hand-rolling a raw <button> with a chevron
 * span at each call site.
 */
export default function DisclosureButton({ open, onClick, children, className = '' }: Props) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-expanded={open}
      className={`flex w-full items-center gap-2 px-4 py-3 text-left hover:bg-hover ${className}`}
    >
      <span className="w-3 shrink-0 text-[12px] text-ink-4">{open ? '▾' : '▸'}</span>
      {children}
    </button>
  );
}
