'use client';

type Size = 'sm' | 'md';

type Props = {
  value: number;
  onChange: (v: number) => void;
  /** Number of stars. Default 5 (the only value used today). */
  max?: number;
  /** `sm` = 12px stars (MemoriesClient's per-row rating). `md` = 16px (NewMemoryModal's form picker). */
  size?: Size;
  disabled?: boolean;
  /** When true, renders a "Pinned" badge next to the stars — clicking it calls `onUnpin`.
   *  Omit (or false) for a plain picker with no lock affordance. */
  locked?: boolean;
  onUnpin?: () => void;
  className?: string;
};

const STAR_PATH = 'M8 1.5l1.9 3.9 4.3.6-3.1 3 .7 4.3L8 11.3l-3.8 2 .7-4.3-3.1-3 4.3-.6z';

/**
 * StarRating — the 1-5 importance picker shared by NewMemoryModal's form
 * (plain, no lock) and MemoriesClient's per-row rating (with the "Pinned by
 * you" badge that lets the user hand control back to the curator). Both call
 * sites rendered their own star-button loop with identical markup before this
 * was extracted (audit DS Phase 2C).
 */
export default function StarRating({
  value,
  onChange,
  max = 5,
  size = 'md',
  disabled,
  locked,
  onUnpin,
  className = '',
}: Props) {
  const dim = size === 'md' ? 'h-[16px] w-[16px]' : 'h-[12px] w-[12px]';
  return (
    <div className={`inline-flex items-center gap-1 ${className}`}>
      <div
        className="inline-flex items-center gap-0.5"
        aria-label={`Importance ${value} of ${max}`}
      >
        {Array.from({ length: max }, (_, i) => i + 1).map((star) => (
          <button
            key={star}
            type="button"
            disabled={disabled}
            onClick={() => onChange(star)}
            title={`Set importance to ${star}`}
            className="p-0.5 text-ink-4 transition-colors hover:text-amber-500 disabled:opacity-50"
          >
            <svg
              viewBox="0 0 16 16"
              className={dim}
              fill={star <= value ? '#f5a623' : 'none'}
              stroke={star <= value ? '#f5a623' : 'currentColor'}
              strokeWidth="1.3"
            >
              <path d={STAR_PATH} />
            </svg>
          </button>
        ))}
      </div>
      {locked && onUnpin && (
        <button
          type="button"
          disabled={disabled}
          onClick={onUnpin}
          title="Pinned by you — click to let the curator manage it again"
          className="group inline-flex h-[20px] cursor-pointer items-center gap-1 rounded-full border border-amber-500/30 bg-amber-500/10 px-2 text-[10px] font-medium text-amber-600 transition-colors hover:border-rule hover:bg-hover hover:text-ink disabled:cursor-default disabled:opacity-50"
        >
          <svg viewBox="0 0 16 16" className="h-[9px] w-[9px] shrink-0" fill="currentColor">
            <path d="M8 1a3 3 0 0 0-3 3v2H4a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V7a1 1 0 0 0-1-1h-1V4a3 3 0 0 0-3-3zm-1.5 5V4a1.5 1.5 0 0 1 3 0v2z" />
          </svg>
          {/* Both labels are always placed in the same grid cell (stacked) so the
              pill's intrinsic width is driven by the wider word ("Pinned") at all
              times — toggling `visibility` on hover swaps which one is seen
              without ever reflowing the button. */}
          <span className="grid">
            <span className="col-start-1 row-start-1 group-hover:invisible">Pinned</span>
            <span className="invisible col-start-1 row-start-1 group-hover:visible">Unpin</span>
          </span>
        </button>
      )}
    </div>
  );
}
