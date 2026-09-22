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
  /**
   * Horizontal inset of the row — the ONLY way to set it. `default` is 16px,
   * `tight` 12px (the thread board, #135), `none` 0 for a row that carries no
   * frame of its own. It is a prop and not a `className` because Tailwind emits
   * one rule per utility in a fixed order: `.px-4` comes last of the four, so a
   * caller appending `px-3` or `px-0` was silently overruled and every foldable
   * block of the feed sat at 16px (#151). A `px-*` in `className` is now a
   * defect, and `__tests__/DisclosureButton.test.tsx` refuses it.
   */
  inset?: 'default' | 'tight' | 'none';
  /**
   * Vertical inset of the row, for the same reason (#399): the base `py-3`
   * overruled a `py-2` or `py-0` passed through `className` — measured in
   * #396, 12px rendered for 8 asked. `default` is 12px, `tight` 8px, `none` 0
   * for a row whose height is set by its caller. A `py-*` in `className` is
   * refused by the same guard as `px-*`.
   */
  insetY?: 'default' | 'tight' | 'none';
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
/** 16px / 12px / 0 — written out so Tailwind sees each class literally. */
const INSET = { default: 'px-4', tight: 'px-3', none: 'px-0' } as const;
/** 12px / 8px / 0, same reason (#399). */
const INSET_Y = { default: 'py-3', tight: 'py-2', none: 'py-0' } as const;

export default function DisclosureButton({
  open,
  onClick,
  children,
  chevron = 'start',
  inset = 'default',
  insetY = 'default',
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
      className={`flex w-full items-center gap-2 ${INSET[inset]} ${INSET_Y[insetY]} text-left hover:bg-hover ${className}`}
    >
      {chevron === 'start' && caret}
      {children}
      {chevron === 'end' && caret}
    </button>
  );
}
