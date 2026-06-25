type Avatar = {
  /** Stable identifier for the React key — typically the agent id. */
  id: string;
  /** Full name; only the initials are rendered when there's no avatar. */
  name: string;
  /** Bundled avatar path (e.g. `/avatars/avatar-07.png`). Falls back to the
   *  initials disc only when null/absent. */
  avatarUrl?: string | null;
};

type Props = {
  avatars: Avatar[];
  /** Maximum heads to render before collapsing the tail into "+N". */
  max?: number;
  /** Trailing label, e.g. "5 agents". Rendered inline after the stack. */
  label?: string;
  className?: string;
};

function initials(name: string): string {
  const t = name.trim();
  if (!t) return '?';
  const parts = t.split(/\s+/);
  if (parts.length >= 2) return ((parts[0]![0] ?? '') + (parts[1]![0] ?? '')).toUpperCase();
  return t.slice(0, 2).toUpperCase();
}

/**
 * AvatarStack — overlapping cluster of small initials avatars with an
 * optional trailing label ("3 agents"). Maps to `.av-stack` in the
 * design bundle (used in /skills assigned table to show which agents
 * use a skill).
 *
 * Tail collapses to "+N" when more avatars than `max` are provided.
 * Each avatar gets a 2px paper-coloured border so they ring-out cleanly
 * against the table row.
 */
export default function AvatarStack({ avatars, max = 5, label, className = '' }: Props) {
  if (avatars.length === 0) {
    return label ? (
      <span className={`font-sans text-[13px] leading-none text-ink-3 ${className}`}>{label}</span>
    ) : null;
  }
  const head = avatars.slice(0, max);
  const overflow = avatars.length - head.length;

  return (
    <span className={`inline-flex items-center gap-2.5 ${className}`}>
      <span className="inline-flex">
        {head.map((a, i) => (
          <span
            key={a.id}
            className={`flex h-6 w-6 items-center justify-center overflow-hidden rounded-full border-2 border-paper bg-agent-vivid text-[11px] font-semibold leading-none tracking-[0.04em] text-[#0a0a0a] ${
              i === 0 ? '' : '-ml-[7px]'
            }`}
            title={a.name}
          >
            {a.avatarUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={a.avatarUrl} alt="" className="h-full w-full object-cover" />
            ) : (
              initials(a.name)
            )}
          </span>
        ))}
        {overflow > 0 && (
          <span className="flex h-6 w-6 -ml-[7px] items-center justify-center rounded-full border-2 border-paper bg-hover text-[11px] font-semibold leading-none text-ink-3">
            +{overflow}
          </span>
        )}
      </span>
      {label && <span className="font-sans text-[13px] leading-none text-ink-3">{label}</span>}
    </span>
  );
}
