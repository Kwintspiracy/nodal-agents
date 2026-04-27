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
    bg: 'bg-emerald-950/50 border border-emerald-900/50',
    text: 'text-emerald-400',
    dot: 'bg-emerald-500',
    pulse: false,
  },
  failed: {
    bg: 'bg-red-950/50 border border-red-900/50',
    text: 'text-red-400',
    dot: 'bg-red-500',
    pulse: false,
  },
  processing: {
    bg: 'bg-amber-950/50 border border-amber-900/50',
    text: 'text-amber-400',
    dot: 'bg-amber-400',
    pulse: true,
  },
  pending: {
    bg: 'bg-neutral-800/60 border border-neutral-700/50',
    text: 'text-neutral-400',
    dot: 'bg-neutral-500',
    pulse: false,
  },
  awaiting_approval: {
    bg: 'bg-violet-950/50 border border-violet-900/50',
    text: 'text-violet-400',
    dot: 'bg-violet-400',
    pulse: true,
  },
  awaiting_delegation: {
    bg: 'bg-blue-950/50 border border-blue-900/50',
    text: 'text-blue-400',
    dot: 'bg-blue-400',
    pulse: true,
  },
  cancelled: {
    bg: 'bg-neutral-800/40 border border-neutral-700/30',
    text: 'text-neutral-500',
    dot: 'bg-neutral-600',
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
