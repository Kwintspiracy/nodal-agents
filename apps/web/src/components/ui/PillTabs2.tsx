'use client';

import { useState, type ReactNode } from 'react';

export type PillTab2<T extends string> = {
  value: T;
  label: ReactNode;
  /** Tiny mono count rendered to the right of the label ("· 12"). */
  count?: number | string;
};

type Props<T extends string> = {
  tabs: PillTab2<T>[];
  value?: T;
  defaultValue?: T;
  onChange?: (next: T) => void;
};

/**
 * PillTabs2 — outlined segmented control used in the page-top bar of
 * Skills / Connectors / Agent detail. Maps to `.pg-tb .pill-tabs2` in
 * the design bundle.
 *
 * Distinct from the simpler `PillTabs` (which lives inside cards) —
 * this variant is paper-on-paper with an INK active pill, sized for a
 * primary navigation surface rather than a card-header range selector.
 * Same controlled/uncontrolled pattern.
 */
export default function PillTabs2<T extends string>({
  tabs,
  value,
  defaultValue,
  onChange,
}: Props<T>) {
  const [internal, setInternal] = useState<T>(value ?? defaultValue ?? tabs[0]!.value);
  const active = value ?? internal;

  return (
    <div
      className="inline-flex gap-1 rounded-[11px] border border-rule-2 bg-paper p-1"
      role="tablist"
    >
      {tabs.map((t) => {
        const isActive = t.value === active;
        return (
          <button
            key={t.value}
            type="button"
            role="tab"
            aria-selected={isActive}
            onClick={() => {
              if (value === undefined) setInternal(t.value);
              onChange?.(t.value);
            }}
            className={`inline-flex h-[30px] items-center gap-2 rounded-lg border-0 px-3.5 text-[13px] font-medium leading-none transition-colors ${
              isActive ? 'bg-ink text-canvas' : 'bg-transparent text-ink-3 hover:text-ink-2'
            }`}
          >
            {t.label}
            {t.count !== undefined && (
              <span
                className={`font-mono text-[12px] leading-none ${
                  isActive ? 'opacity-65' : 'opacity-60'
                }`}
              >
                · {t.count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
