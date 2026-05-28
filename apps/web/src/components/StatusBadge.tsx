type Status =
  | 'pending'
  | 'processing'
  | 'completed'
  | 'failed'
  | 'awaiting_approval'
  | 'awaiting_delegation'
  | 'cancelled'
  | string;

const CONFIG: Record<string, { bg: string; text: string; dot: string; pulse: boolean }> = {
  completed: {
    bg: 'bg-ok-bg border border-ok/30',
    text: 'text-ok',
    dot: 'bg-ok',
    pulse: false,
  },
  failed: {
    bg: 'bg-warn-bg border border-err/30',
    text: 'text-err',
    dot: 'bg-err',
    pulse: false,
  },
  processing: {
    bg: 'bg-warn-bg border border-warn/30',
    text: 'text-warn',
    dot: 'bg-warn',
    pulse: true,
  },
  pending: {
    bg: 'bg-hover border border-rule',
    text: 'text-ink-3',
    dot: 'bg-ink-3',
    pulse: false,
  },
  awaiting_approval: {
    bg: 'bg-run-bg border border-run/30',
    text: 'text-run',
    dot: 'bg-run',
    pulse: true,
  },
  awaiting_delegation: {
    bg: 'bg-run-bg border border-run/30',
    text: 'text-run',
    dot: 'bg-run',
    pulse: true,
  },
  cancelled: {
    bg: 'bg-hover border border-rule',
    text: 'text-ink-3',
    dot: 'bg-ink-4',
    pulse: false,
  },
};

export default function StatusBadge({ status }: { status: Status }) {
  const cfg = CONFIG[status] ?? CONFIG['pending']!;
  return (
    <span
      className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md text-xs font-semibold ${cfg.bg} ${cfg.text}`}
    >
      <span
        className={`w-1.5 h-1.5 rounded-full shrink-0 ${cfg.dot} ${cfg.pulse ? 'animate-pulse' : ''}`}
      />
      {status}
    </span>
  );
}
