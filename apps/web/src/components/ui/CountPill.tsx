'use client';

import { ListBullets } from '@phosphor-icons/react';

/**
 * CountPill — a compact "N <noun>s" chip that lists its items in a native
 * tooltip on hover. Used wherever a long list of values (OAuth scope URLs,
 * required built-ins…) would otherwise blow out a table column or card.
 *
 * The native `title` attribute is deliberate: it can't be clipped by the
 * `overflow-hidden` / `overflow-x-auto` wrappers around tables, unlike an
 * absolutely-positioned custom popover. Render only when `items` is non-empty.
 */
export default function CountPill({ items, noun }: { items: string[]; noun: string }) {
  const n = items.length;
  return (
    <span
      title={items.join('\n')}
      className="inline-flex cursor-help items-center gap-1.5 rounded-md border border-rule-2 bg-hover px-2 py-1 text-mono-11 whitespace-nowrap text-ink-2"
    >
      <ListBullets size={12} weight="bold" className="text-ink-4" />
      {n} {noun}
      {n !== 1 ? 's' : ''}
    </span>
  );
}
