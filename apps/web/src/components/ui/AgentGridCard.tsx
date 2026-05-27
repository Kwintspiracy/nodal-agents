import Link from 'next/link';
import AgentAvatar from './AgentAvatar';
import AgentStatus, { type AgentStatusVariant } from './AgentStatus';
import type { ActiveAgentRow } from '@/lib/actions.ts';

type AgentCardData = {
  id: string;
  name: string;
  slug: string;
  role?: string | null;
  avatarUrl?: string | null;
};

type Props = {
  agent: AgentCardData;
  activity: ActiveAgentRow | null;
};

/**
 * AgentGridCard — paper card for the Grid view of /agents.
 * Maps to `.ag-card` in the design bundle (screen-gallery.jsx v3 + styles.css
 * lines 1729-1808).
 *
 * Shows: lime square avatar (robot icon), name + role, status indicator,
 * and an activity badge when jobs are in flight. No fabricated metrics —
 * success rate / cost / runs are not tracked per-agent and are omitted
 * rather than shown as placeholder dashes.
 *
 * Click targets /agents/{id}/edit. No nested interactive elements conflict
 * with the card click because the "more" button is a separate accessible
 * element (pointer-down stops propagation).
 */
export default function AgentGridCard({ agent, activity }: Props) {
  const status = deriveStatus(activity);

  return (
    <Link
      href={`/agents/${agent.id}/edit`}
      className="group block rounded-[14px] border border-rule-2 bg-paper p-[18px] transition-[border-color] hover:border-rule focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink-3"
      style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}
    >
      {/* Header: avatar + name/role + more */}
      <div className="flex items-center gap-3">
        <AgentAvatar
          name={agent.name}
          imageUrl={agent.avatarUrl}
          size="lg"
          shape="square"
          className="bg-agent-vivid text-[#0a0a0a]"
        />
        <div className="min-w-0 flex-1">
          <div className="truncate text-[15px] font-semibold leading-[1.2] tracking-[-0.005em] text-ink">
            {agent.name}
          </div>
          <div className="mt-0.5 truncate text-[12.5px] leading-[1.3] text-ink-3">
            {agent.role ?? 'agent'}
          </div>
        </div>
      </div>

      {/* Status row */}
      <AgentStatus
        variant={status}
        note={
          activity && activity.total > 0
            ? `${activity.total} run${activity.total === 1 ? '' : 's'} active`
            : 'no active runs'
        }
      />

      {/* Footer: slug mono */}
      <div className="flex items-center border-t border-rule-2 pt-3">
        <span className="font-mono text-[11px] text-ink-4">{agent.slug}</span>
      </div>
    </Link>
  );
}

/**
 * Derive a display status from the live activity snapshot.
 * No real paused/warn signal in AgentRow today — we derive:
 *   - running  when processing > 0
 *   - warn     when awaiting > 0 (stuck waiting)
 *   - idle     otherwise
 */
function deriveStatus(activity: ActiveAgentRow | null): AgentStatusVariant {
  if (!activity || activity.total === 0) return 'idle';
  if (activity.processing > 0) return 'running';
  if (activity.awaiting > 0) return 'warn';
  return 'idle';
}
