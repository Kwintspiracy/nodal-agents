import type { ReactNode } from 'react';

type Props = {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
  className?: string;
};

/**
 * ToggleChip — small pill for an INDEPENDENTLY toggleable option inside a
 * multi-select set (e.g. CronBuilder's weekday picker: Mon/Tue/Wed… each
 * toggles on its own). Distinct from `ChipRow` (single-select filter row)
 * and `PillTabs` (single-select segmented control) — those two own a
 * `value`/`onChange` over the whole set, whereas here each chip owns its
 * own on/off state, so the caller maps a list of these directly (same
 * single-item-component convention as `OptionRadio`).
 */
export default function ToggleChip({ active, onClick, children, className = '' }: Props) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded border px-2.5 py-1 text-xs font-medium ${
        active
          ? 'border-run/30 bg-run-bg text-run'
          : 'border-rule-2 text-ink-3 hover:border-rule hover:text-ink'
      } ${className}`}
    >
      {children}
    </button>
  );
}
