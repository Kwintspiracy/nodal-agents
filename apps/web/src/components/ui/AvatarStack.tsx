type Avatar = {
  /** Stable identifier for the React key — typically the agent id. */
  id: string;
  /** Full name; only the initials are rendered when there's no avatar. */
  name: string;
  /** Bundled avatar path (e.g. `/avatars/avatar-07.png`). Falls back to the
   *  initials tile only when null/absent. */
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

/** Une tuile de 24 px, carrée à coins de 4 : la forme du composant Figma `AvatarStack` (53:10). */
const TILE = 'flex h-6 w-6 shrink-0 items-center justify-center overflow-hidden rounded';

/**
 * AvatarStack — a row of small agent tiles with an optional trailing label
 * ("5 agents"). Maps to the Figma component `AvatarStack` (53:10): 24 px
 * rounded SQUARES side by side with a 2 px gap — not overlapping discs — the
 * initials in `Mono/11 Caps` on the agent's lime, a `+N` tile on the hover
 * surface, and the label in `Medium/13`. The real avatar image replaces the
 * initials whenever the agent has one (Quentin, 17/09/2026: « à remplacer par
 * les avatars quand disponibles »).
 *
 * Tail collapses to "+N" when more avatars than `max` are provided.
 */
export default function AvatarStack({ avatars, max = 5, label, className = '' }: Props) {
  if (avatars.length === 0) {
    return label ? (
      <span className={`text-medium-13 leading-none! text-ink-3 ${className}`}>{label}</span>
    ) : null;
  }
  const head = avatars.slice(0, max);
  const overflow = avatars.length - head.length;

  return (
    <span className={`inline-flex items-center gap-2.5 ${className}`}>
      <span className="inline-flex gap-0.5">
        {head.map((a) => (
          <span
            key={a.id}
            className={`${TILE} bg-agent-vivid text-mono-11-caps text-[#0a0a0a]`}
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
          <span className={`${TILE} bg-hover text-mono-11-caps text-ink-3`}>+{overflow}</span>
        )}
      </span>
      {label && <span className="text-medium-13 leading-none! text-ink-3">{label}</span>}
    </span>
  );
}
