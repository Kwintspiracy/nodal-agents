import type { ReactNode } from 'react';

export type ChipItem<T extends string> = {
  value: T;
  label: ReactNode;
  /** Optional mono count, rendered after the label. */
  count?: number | string;
};

type Props<T extends string> = {
  items: ChipItem<T>[];
  value: T;
  onChange: (next: T) => void;
  className?: string;
};

/**
 * ChipRow — horizontal row of filter chips. Maps to `.chip-row .chip`
 * in the design bundle (Connectors page categories, Memory page agent
 * filter, etc.).
 *
 * Active chip = ink fill (canvas text). Inactive = paper bg with rule
 * border. The chip ROW handles the layout (flex wrap, gap); each chip
 * is exposed as a button so callers can wire keyboard nav if needed.
 *
 * Controlled-only (no internal state) — list pages typically own the
 * filter value because it's mirrored into the URL.
 */
export default function ChipRow<T extends string>({
  items,
  value,
  onChange,
  className = '',
}: Props<T>) {
  return (
    <div className={`flex flex-wrap items-center gap-2 ${className}`}>
      {items.map((it) => {
        const isActive = it.value === value;
        return (
          <button
            key={it.value}
            type="button"
            onClick={() => onChange(it.value)}
            className={`inline-flex h-8 items-center gap-1.5 rounded-[9px] border px-3.5 text-medium-13 leading-none! transition-colors ${
              isActive
                ? 'border-ink bg-ink text-canvas'
                : 'border-rule-2 bg-paper text-ink-2 hover:bg-hover'
            }`}
          >
            {it.label}
            {it.count !== undefined && (
              <span
                className={`text-mono-12 leading-none! ${isActive ? 'opacity-65' : 'opacity-55'}`}
              >
                {it.count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
