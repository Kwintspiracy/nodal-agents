import type { ReactNode } from 'react';

type Props = {
  selected: boolean;
  onClick: () => void;
  /** Used as both the tooltip and the `aria-label` — same rationale as
   *  RowActionButton's square shape: there's no visible text label to fall
   *  back on. */
  label: string;
  children: ReactNode;
  className?: string;
};

/**
 * SelectableTile — square, centered tile in a picker grid, ring-highlighted
 * when selected. Distinct from `OptionRadio` (name+description radio card)
 * and `ChoiceTile` (icon+label navigation row) — this is for grids of
 * purely visual choices (AvatarPicker's avatar gallery).
 */
export default function SelectableTile({
  selected,
  onClick,
  label,
  children,
  className = '',
}: Props) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      aria-pressed={selected}
      className={`flex aspect-square items-center justify-center rounded-lg p-1 transition-all ${
        selected
          ? 'bg-ink/10 ring-2 ring-emerald-400'
          : 'bg-hover ring-1 ring-transparent hover:bg-hover hover:ring-neutral-700'
      } ${className}`}
    >
      {children}
    </button>
  );
}
