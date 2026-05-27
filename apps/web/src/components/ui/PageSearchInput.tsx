'use client';

import { MagnifyingGlass } from '@phosphor-icons/react';
import type { ChangeEvent } from 'react';

type Props = {
  value: string;
  onChange: (next: string) => void;
  placeholder?: string;
  /** Min width — defaults to 300px to match the design's `.pg-tb .search`. */
  minWidth?: number;
  className?: string;
};

/**
 * PageSearchInput — search field used INSIDE PageTopBar (skills/connectors/
 * agents-list). Maps to `.pg-tb .search` in the design bundle.
 *
 * Distinct from `SearchBox` (which lives in the topbar with the `/` kbd
 * hint and a form submit handler) — this one is controlled, doesn't
 * carry the kbd hint, and binds to the page's local filter state.
 */
export default function PageSearchInput({
  value,
  onChange,
  placeholder = 'Search…',
  minWidth = 300,
  className = '',
}: Props) {
  return (
    <div
      className={`flex h-[34px] items-center gap-2 rounded-[9px] border border-rule-2 bg-paper px-3 text-[12.5px] text-ink-4 ${className}`}
      style={{ minWidth }}
    >
      <MagnifyingGlass size={13} className="shrink-0" />
      <input
        type="search"
        value={value}
        onChange={(e: ChangeEvent<HTMLInputElement>) => onChange(e.target.value)}
        placeholder={placeholder}
        className="flex-1 border-0 bg-transparent text-[13px] leading-none text-ink outline-none placeholder:text-ink-4"
      />
    </div>
  );
}
