import Image from 'next/image';

type Props = {
  /** Up to 2 letters. When a name is passed, takes the first letters of the
   *  first two words; falls back to the first 2 characters otherwise. */
  name: string;
  /** Optional uploaded image. When provided, replaces the initials. */
  imageUrl?: string | null;
  size?: 'sm' | 'md' | 'lg';
  /** Visual shape:
   *   - `round` (default) — circle, used in tables
   *   - `square` — rounded square, used in marketplace / agent grid cards */
  shape?: 'round' | 'square';
  className?: string;
};

const SIZE: Record<NonNullable<Props['size']>, { box: string; text: string; px: number }> = {
  sm: { box: 'h-6 w-6', text: 'text-[11px]', px: 24 },
  md: { box: 'h-[30px] w-[30px]', text: 'text-[11px]', px: 30 },
  lg: { box: 'h-[42px] w-[42px]', text: 'text-[15px]', px: 42 },
};

function initials(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return '?';
  const parts = trimmed.split(/\s+/);
  if (parts.length >= 2) {
    return ((parts[0]![0] ?? '') + (parts[1]![0] ?? '')).toUpperCase();
  }
  return trimmed.slice(0, 2).toUpperCase();
}

/**
 * AgentAvatar — the small "AT" / "ME" tile used in the Home activity
 * table and most agent-listing surfaces. Maps to `.h-tbl .agt .av`
 * (round) and `.ag-orb-sm` (square) in the design bundle.
 *
 * When the agent has a real avatar uploaded, falls through to next/image
 * so it gets the same optimization pipeline as the rest of the app.
 */
export default function AgentAvatar({
  name,
  imageUrl,
  size = 'md',
  shape = 'round',
  className = '',
}: Props) {
  const s = SIZE[size];
  const radius = shape === 'round' ? 'rounded-full' : 'rounded-[8px]';
  const base = `inline-flex shrink-0 items-center justify-center overflow-hidden bg-hover font-mono font-semibold tracking-[0.04em] text-ink-2 ${s.box} ${s.text} ${radius} ${className}`;

  if (imageUrl) {
    return (
      <span className={base}>
        <Image
          src={imageUrl}
          alt={name}
          width={s.px}
          height={s.px}
          className="h-full w-full object-cover"
        />
      </span>
    );
  }

  return <span className={base}>{initials(name)}</span>;
}
