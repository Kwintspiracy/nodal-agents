'use client';

import type { ReactNode } from 'react';

type Option<T extends string> = {
  value: T;
  label: ReactNode;
  /** Classes applied only when this option is the active one — lets each
   *  option carry its own accent (e.g. destructive red for "Block", amber
   *  for "Ask first") instead of a single flat active colour. */
  activeClassName?: string;
  /** Passed through as `data-testid` — e2e tests target individual segments. */
  testId?: string;
};

type Props<T extends string> = {
  options: Option<T>[];
  value: T;
  onChange: (next: T) => void;
  disabled?: boolean;
  ariaLabel?: string;
  className?: string;
};

const DEFAULT_ACTIVE = 'bg-ink text-canvas border-ink';
const INACTIVE = 'bg-canvas text-ink-3 hover:bg-hover hover:text-ink-2';

/**
 * SegmentedControl — a bordered row of mutually-exclusive text segments
 * (n-way toggle), e.g. the per-tool Autonomous / Ask first / Block control on
 * the agent Autonomy tab. Each segment can carry its own `activeClassName`
 * for a distinct selected-state accent — SegmentedControl owns only the
 * shared geometry (border, divider between segments, height, disabled/saving
 * state), not per-option colour.
 */
export default function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  disabled,
  ariaLabel,
  className = '',
}: Props<T>) {
  return (
    // w-fit : la bordure doit épouser les segments. Sans elle, posé dans un
    // parent block (ex. une modale), le conteneur flex s'étire et la zone vide
    // après le dernier segment ressemble à un segment cassé.
    <div
      className={`flex w-fit shrink-0 overflow-hidden rounded-lg border border-rule-2 ${className}`}
      role="group"
      aria-label={ariaLabel}
    >
      {options.map((opt, idx) => {
        const isActive = opt.value === value;
        return (
          <button
            key={opt.value}
            type="button"
            disabled={disabled}
            onClick={() => onChange(opt.value)}
            data-testid={opt.testId}
            className={[
              'relative h-[32px] px-3 text-medium-13 transition-colors',
              idx > 0 ? 'border-l border-rule-2' : '',
              isActive ? (opt.activeClassName ?? DEFAULT_ACTIVE) : INACTIVE,
              disabled ? 'cursor-wait opacity-60' : '',
            ].join(' ')}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}
