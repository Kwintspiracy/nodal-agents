'use client';

import { useState, type ReactNode } from 'react';

export type PillTab<T extends string> = {
  value: T;
  label: ReactNode;
  /** Optional small count rendered to the right of the label. */
  count?: number | string;
};

type Props<T extends string> = {
  tabs: PillTab<T>[];
  value?: T;
  defaultValue?: T;
  onChange?: (next: T) => void;
  /** Visual variant:
   *   - `inset`: design's `.h-tabs` style — gray well bg with paper-coloured
   *     active pill. Used in card headers (e.g. chart range selector).
   *   - `dark-active`: design's `.pill-tabs` style — paper well with INK
   *     (black) active pill. Used as a top-level filter switch.
   *   The two ship together because they share geometry and a11y wiring;
   *   the only difference is colour mapping. */
  variant?: 'inset' | 'dark-active';
};

/**
 * PillTabs — segmented control. Used in `.h-tabs` (chart range) and
 * `.pill-tabs` (top-of-table filter) in the design bundle. Both variants
 * are exposed here so callers pick the right colour mapping without
 * duplicating the component.
 *
 * Controlled (pass `value` + `onChange`) or uncontrolled (pass
 * `defaultValue`) — same prop pattern as native form controls.
 */
export default function PillTabs<T extends string>({
  tabs,
  value,
  defaultValue,
  onChange,
  variant = 'inset',
}: Props<T>) {
  const [internal, setInternal] = useState<T>(value ?? defaultValue ?? tabs[0]!.value);
  const active = value ?? internal;

  const wellBg = variant === 'inset' ? 'bg-black/[0.05]' : 'bg-black/[0.04]';
  const activeBg =
    variant === 'inset'
      ? 'bg-paper text-ink shadow-[0_1px_2px_rgba(0,0,0,0.06)]'
      : 'bg-ink text-canvas';

  return (
    <div className={`inline-flex gap-0.5 rounded-md p-[3px] ${wellBg}`} role="tablist">
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
            className={`inline-flex h-[26px] items-center gap-1.5 rounded-[6px] border-0 px-3 text-[11.5px] font-medium leading-none transition-colors ${
              isActive ? activeBg : 'bg-transparent text-ink-3 hover:text-ink-2'
            }`}
          >
            {t.label}
            {t.count !== undefined && (
              <span className={`font-mono text-[10px] ${isActive ? 'opacity-85' : 'opacity-65'}`}>
                {t.count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
