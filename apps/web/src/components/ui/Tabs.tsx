'use client';

import type { ReactNode } from 'react';

export type TabItem<T extends string> = {
  id: T;
  label: ReactNode;
  /** Optional mono count shown after the label. Hidden when 0 or undefined. */
  count?: number;
};

type Props<T extends string> = {
  tabs: TabItem<T>[];
  value: T;
  onChange: (id: T) => void;
  className?: string;
};

/**
 * Tabs — underline tab bar: a `border-b` track with the active tab underlined
 * in `border-ink`. The page-level section switcher on detail pages (the agent
 * edit page's Overview/Skills/…/Settings strip).
 *
 * Distinct from `PillTabs`/`PillTabs2` (pill-in-a-well toggles that live inside
 * cards or page-top bars) — this is the flat underline variant. Extracted from
 * AgentComposer's inline `TabBar` (DS: an underline tab strip is a real
 * recurring chrome, not a one-off). Uses the `role="tab"` div pattern rather
 * than a bare `<button>` because the label+count content is richer than a
 * button models cleanly — same pattern already used for OptionRadio /
 * ConversationRow.
 */
export default function Tabs<T extends string>({
  tabs,
  value,
  onChange,
  className = '',
}: Props<T>) {
  return (
    <div className={`flex gap-1 border-b border-rule-2 ${className}`} role="tablist">
      {tabs.map((t) => {
        const isActive = t.id === value;
        return (
          <div
            key={t.id}
            role="tab"
            aria-selected={isActive}
            tabIndex={0}
            onClick={() => onChange(t.id)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onChange(t.id);
              }
            }}
            className={[
              'relative -mb-px cursor-pointer border-b-2 px-4 pt-2.5 pb-3 text-medium-14 transition-colors',
              isActive ? 'border-ink text-ink' : 'border-transparent text-ink-3 hover:text-ink-2',
            ].join(' ')}
          >
            {t.label}
            {t.count !== undefined && t.count > 0 && (
              <span
                className={`ml-1.5 text-mono-11 ${isActive ? 'text-ink-2' : 'text-ink-4'}`}
              >
                {t.count}
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}
