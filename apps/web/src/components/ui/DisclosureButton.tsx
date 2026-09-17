'use client';

import type { ReactNode } from 'react';
import { CaretDown, CaretRight } from '@phosphor-icons/react/dist/ssr';

type Props = {
  open: boolean;
  onClick: () => void;
  /** Rich row content next to the chevron — name, badges, trailing meta. No
   *  nested interactive elements (real <button> can't contain one); rows that
   *  need a nested action (e.g. a delete icon) should use the div[role="button"]
   *  pattern instead (see ChatClient's ConversationRow / MemoriesClient's
   *  MemoryFact). */
  children: ReactNode;
  /**
   * Where the chevron sits. `start` (default) is the accordion convention —
   * the caret leads the row. `end` puts it hard right, for rows whose content
   * IS the row (a reasoning summary, a delegation) and whose caret is the last
   * thing the eye meets, per the thread design (P2bis). With `end`, the row's
   * own trailing meta carries its `ml-auto`.
   */
  chevron?: 'start' | 'end';
  className?: string;
  /** Passed through as `data-testid` — tests and e2e journeys target the row
   *  that unfolds, which is otherwise indistinguishable from any other row. */
  testId?: string;
};

/**
 * DisclosureButton — full-width accordion trigger: chevron + arbitrary
 * content, toggling `aria-expanded`. A real <button> (native keyboard/focus
 * behaviour for free), so it's only for rows whose content has no nested
 * interactive element of its own — promoted from RootContextClient's skill
 * list (DS Phase 2R) instead of hand-rolling a raw <button> with a chevron
 * span at each call site.
 */
export default function DisclosureButton({
  open,
  onClick,
  children,
  chevron = 'start',
  className = '',
  testId,
}: Props) {
  const caret = (
    <span className="flex w-3.5 shrink-0 items-center text-ink-4" aria-hidden>
      {open ? <CaretDown size={14} /> : <CaretRight size={14} />}
    </span>
  );
  return (
    <button
      type="button"
      onClick={onClick}
      aria-expanded={open}
      data-testid={testId}
      className={`flex w-full items-center gap-2 px-4 py-3 text-left hover:bg-hover ${className}`}
    >
      {chevron === 'start' && caret}
      {children}
      {chevron === 'end' && caret}
    </button>
  );
}
