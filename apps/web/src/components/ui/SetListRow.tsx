'use client';

import type { ReactNode } from 'react';
import { CaretRight } from '@phosphor-icons/react/dist/ssr';

type Props = {
  /** Leading glyph — a Phosphor icon element, sized by the caller. */
  icon: ReactNode;
  /** The setting's name, in a fixed column so every value starts at the same x. */
  name: string;
  /** The value in force, read from the config or the DB. Truncated when long. */
  value: string;
  /** A pill or a state picture, between the value and the chevron. Never a control. */
  trailing?: ReactNode;
  /** True when this row's setting is the one open in the panel. */
  selected?: boolean;
  onClick: () => void;
  testId?: string;
};

/**
 * SetListRow — one row of the settings list (S3, #231): icon, name, current
 * value, an optional pill or state picture, and the chevron that says the row
 * opens something.
 *
 * A real `<button>`, so keyboard and focus come for free. That is also its
 * limit: it must carry NO nested interactive element, which is exactly the
 * rule the list needs anyway — nothing is edited from the list, the gesture
 * lives in the panel the row opens. A row that needs a nested action belongs
 * in the `div[role="button"]` pattern instead, like ConversationRow.
 *
 * Sits in the Set* family (SetBlock, SetPane, SetRow, SetForm) rather than in
 * the settings folder, because the pattern is the list, not the subject.
 */
export default function SetListRow({
  icon,
  name,
  value,
  trailing,
  selected = false,
  onClick,
  testId,
}: Props) {
  return (
    <button
      type="button"
      onClick={onClick}
      data-testid={testId}
      data-selected={selected ? 'true' : 'false'}
      className={`flex h-11 w-full items-center gap-3 border-b border-rule-2 pr-3.5 pl-4 text-left transition-colors last:border-b-0 ${
        selected ? 'bg-hover' : 'hover:bg-hover'
      }`}
    >
      <span className="flex shrink-0 items-center text-ink-3" aria-hidden>
        {icon}
      </span>
      <span className="w-[180px] shrink-0 truncate text-medium-14 text-ink">{name}</span>
      <span className="min-w-0 flex-1 truncate text-body-13 text-ink-3">{value}</span>
      {trailing}
      <span className="flex shrink-0 items-center text-ink-4" aria-hidden>
        <CaretRight size={14} />
      </span>
    </button>
  );
}
