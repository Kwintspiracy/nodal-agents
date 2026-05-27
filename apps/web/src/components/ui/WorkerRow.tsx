import AgentAvatar from './AgentAvatar';
import LiveDot from './LiveDot';
import type { ActiveAgentRow } from '@/lib/actions.ts';

/** Six-dot 2×3 drag handle rendered as a CSS grid of tiny circles. */
function DragDots() {
  return (
    <span
      className="grid shrink-0 text-ink-4"
      style={{
        gridTemplateColumns: 'repeat(2, 3px)',
        gap: '2px',
        width: '8px',
        height: '14px',
      }}
      aria-hidden
    >
      {Array.from({ length: 6 }).map((_, i) => (
        <i key={i} className="inline-block h-[3px] w-[3px] rounded-full bg-current" />
      ))}
    </span>
  );
}

type AgentData = {
  id: string;
  name: string;
  slug: string;
  role?: string | null;
  avatarUrl?: string | null;
};

type Props = {
  agent: AgentData;
  activity: ActiveAgentRow | null;
  /** Drag-handle props forwarded from dnd-kit useSortable. */
  dragHandleProps?: object;
  /** Passed to the row element for dnd-kit transform/transition. */
  style?: React.CSSProperties;
  /** Extra class, e.g. opacity-50 during drag. */
  className?: string;
  /** Click handler — navigates to edit page when the full row is clicked. */
  onClick?: () => void;
  /** Ref forwarded to the root element (dnd-kit setNodeRef). */
  rowRef?: React.Ref<HTMLDivElement>;
};

/**
 * WorkerRow — a single worker slot inside an OrchestratorCard's `.orc-workers`
 * bucket. Maps to `.wkr` in the design bundle (styles.css lines 1854-1882).
 *
 * Renders: drag handle, mini round avatar, name + role, live status dot +
 * active count. The drag-handle area is separated into its own element so
 * dnd-kit's pointer listeners are scoped to it — clicks on the rest of the
 * row navigate without triggering a drag.
 */
export default function WorkerRow({
  agent,
  activity,
  dragHandleProps,
  style,
  className = '',
  onClick,
  rowRef,
}: Props) {
  const dotVariant = deriveStatusVariant(activity);
  const runsToday = activity?.total ?? 0;

  return (
    <div
      ref={rowRef}
      style={style}
      onClick={onClick}
      className={`flex cursor-pointer items-center gap-3 rounded-[9px] bg-canvas px-3.5 py-2.5 hover:bg-hover dark:bg-white/[0.04] ${className}`}
    >
      {/* Drag handle */}
      <button
        type="button"
        aria-label="Drag to reorder worker"
        className="cursor-grab touch-none active:cursor-grabbing"
        {...dragHandleProps}
        onClick={(e) => e.stopPropagation()}
      >
        <DragDots />
      </button>

      {/* Mini round avatar */}
      <AgentAvatar name={agent.name} imageUrl={agent.avatarUrl} size="sm" shape="round" />

      {/* Name + role */}
      <div className="min-w-0 flex-1">
        <div className="truncate text-[13.5px] font-medium leading-[1.2] text-ink">
          {agent.name}
        </div>
        <div className="mt-0.5 truncate text-[12px] leading-[1.3] text-ink-3">
          {agent.role ?? 'worker'}
        </div>
      </div>

      {/* Status dot + run count */}
      <span className="inline-flex shrink-0 items-center gap-1.5 font-mono text-[12px] text-ink-3">
        <LiveDot variant={dotVariant} animate={dotVariant !== 'lime'} size="sm" />
        {runsToday}
      </span>
    </div>
  );
}

function deriveStatusVariant(activity: ActiveAgentRow | null): 'ok' | 'lime' | 'coral' | 'blue' {
  if (!activity || activity.total === 0) return 'lime'; // lime = agent-vivid = "idle / ready"
  if (activity.processing > 0) return 'ok'; // green = running
  if (activity.awaiting > 0) return 'coral'; // coral = warn / awaiting
  return 'lime';
}
