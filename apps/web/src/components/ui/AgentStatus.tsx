import LiveDot from './LiveDot';

export type AgentStatusVariant = 'running' | 'idle' | 'warn' | 'paused';

type Props = {
  variant: AgentStatusVariant;
  /** Override the default label. */
  label?: string;
  /** Optional secondary note appended after "·". */
  note?: string;
  className?: string;
};

const LABEL: Record<AgentStatusVariant, string> = {
  running: 'Running',
  idle: 'Idle',
  warn: 'Attention',
  paused: 'Paused',
};

/**
 * AgentStatus — inline status indicator used inside AgentGridCard and
 * WorkerRow. Maps to `.ag-status` in the design bundle (screen-gallery.jsx v3).
 *
 * Distinct from StatusPill (which is a pill/badge surface) — this one is
 * a flat inline row: dot + bold label + optional "· note" suffix.
 */
export default function AgentStatus({ variant, label, note, className = '' }: Props) {
  const text = label ?? LABEL[variant];

  const dotVariant =
    variant === 'running'
      ? ('ok' as const)
      : variant === 'warn'
        ? ('coral' as const)
        : variant === 'paused'
          ? ('lime' as const)
          : ('blue' as const);

  return (
    <span
      className={`inline-flex items-center gap-2 text-[13px] leading-none text-ink-2 ${className}`}
    >
      <LiveDot
        variant={dotVariant}
        animate={variant === 'running' || variant === 'warn'}
        size="sm"
      />
      <b className="font-medium text-ink">{text}</b>
      {note && (
        <>
          <span className="text-ink-4">·</span>
          <span>{note}</span>
        </>
      )}
    </span>
  );
}
