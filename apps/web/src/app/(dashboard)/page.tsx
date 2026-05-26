import {
  getEntityStatsAction,
  getActiveJobsByAgentAction,
  getWeeklyActivityAction,
  getHomeActivityAction,
  listSkillsAction,
  listConnectorsAction,
  listMcpServersAction,
} from '@/lib/actions.ts';
import VividStatCard from '@/components/ui/VividStatCard';
import MetricCard from '@/components/ui/MetricCard';
import Sparkline from '@/components/ui/Sparkline';
import StatusPill, { type StatusVariant } from '@/components/ui/StatusPill';
import TypeChip from '@/components/ui/TypeChip';
import AgentAvatar from '@/components/ui/AgentAvatar';
import HomeActivityChart from './HomeActivityChart';
import { UsersThree, Star, PlugsConnected } from '@phosphor-icons/react/dist/ssr';

export const dynamic = 'force-dynamic';

/**
 * Home dashboard — the new flagship at `/`.
 *
 * Three vivid section cards (Agents / Skills / Connectors) reuse the
 * primitives that govern the entire app's identity. Below them sit six
 * white metric cards from the same `EntityStats` aggregate that powers
 * `/stats`, so the numbers tell the same truth (just summarised). The
 * fleet activity chart visualises the existing 12-week status rollup
 * with the design's tinted-area style, and the recent activity table is
 * a join of jobs↔agents capped at 8 rows.
 *
 * What's explicitly NOT here yet (numbers we don't track):
 *   - "+3 this week" deltas → no w/w aggregation exists yet
 *   - skills "awaiting review" → no review workflow in DB
 *   - connectors "uptime %" → no health checks logged
 *   - per-connector "needs auth" tally → no per-connector status surfaced
 * Cards keep their headline values; meta lines that would require
 * fabricated data are simply omitted (better an honest gap than a fake
 * number).
 */
export default async function HomePage() {
  const [statsRes, activeRes, weeklyRes, activityRes, skillsRes, connsRes, mcpRes] =
    await Promise.all([
      getEntityStatsAction(),
      getActiveJobsByAgentAction(),
      getWeeklyActivityAction(),
      getHomeActivityAction({ limit: 8 }),
      listSkillsAction(),
      listConnectorsAction(),
      listMcpServersAction(),
    ]);

  if (!statsRes.ok) {
    return (
      <div className="py-9">
        <h1 className="text-[28px] font-semibold tracking-[-0.015em] text-ink">Home</h1>
        <div className="mt-4 rounded-xl border border-warn/40 bg-warn-bg p-5 text-sm text-warn">
          {statsRes.message}
        </div>
      </div>
    );
  }

  const s = statsRes.data;
  const active = activeRes.ok ? activeRes.data : [];
  const weekly = weeklyRes.ok ? weeklyRes.data : [];
  const activity = activityRes.ok ? activityRes.data : [];
  const skills = skillsRes.ok ? skillsRes.data : [];
  const connectors = connsRes.ok ? connsRes.data.instances : [];
  const mcp = mcpRes.ok ? mcpRes.data.instances : [];

  // Derived metrics — all from real aggregates, no synthesis.
  const runningCount = active.length;
  const skillCount = skills.length;
  const connectorCount = connectors.length + mcp.length;
  const totalTokens = s.totalInputTokens + s.totalOutputTokens;
  const successRate =
    s.totalJobs > 0 ? Math.round(((s.statusCounts['completed'] ?? 0) / s.totalJobs) * 100) : null;
  const tokensPerJob = s.totalJobs > 0 ? Math.round(totalTokens / s.totalJobs) : null;

  // Sparkline series for the vivid cards — derive from the weekly rollup.
  const completedSpark = weekly.map((w) => w.completed);
  const totalSpark = weekly.map(
    (w) => w.completed + w.failed + w.cancelled + w.awaiting + w.pending,
  );

  // Greeting — local time-of-day.
  const greet = getGreeting();
  const todayLabel = new Date().toLocaleDateString(undefined, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  });

  return (
    <div className="py-7">
      {/* Header --------------------------------------------------------- */}
      <div className="mb-5 flex items-baseline justify-between gap-6">
        <div>
          <div className="flex flex-wrap items-baseline gap-3 text-[28px] font-semibold leading-[1.15] tracking-[-0.015em] text-ink">
            {greet}
            <span className="text-[13px] font-medium leading-none text-ink-3">{todayLabel}</span>
          </div>
          <div className="mt-1.5 text-[13px] leading-[1.5] text-ink-3">
            {s.totalJobs > 0 ? (
              <>
                Your fleet has completed{' '}
                <b className="font-medium text-ink">{s.totalJobs.toLocaleString()}</b>{' '}
                {s.totalJobs === 1 ? 'job' : 'jobs'} since the workspace was seeded.
              </>
            ) : (
              <>No jobs run yet. Spin up an agent to start the fleet.</>
            )}
          </div>
        </div>
      </div>

      {/* Three vivid stat cards ----------------------------------------- */}
      <div className="grid grid-cols-1 gap-3.5 md:grid-cols-3">
        <VividStatCard
          variant="agent"
          label="Agents"
          value={s.agentCount}
          icon={<UsersThree size={13} weight="regular" />}
          href="/agents"
          meta={
            runningCount > 0
              ? `${runningCount} ${runningCount === 1 ? 'agent' : 'agents'} active now`
              : 'All agents idle'
          }
          spark={
            completedSpark.length >= 2 ? (
              <Sparkline points={completedSpark} color="#0a0a0a" />
            ) : null
          }
        />
        <VividStatCard
          variant="skill"
          label="Skills"
          value={skillCount}
          icon={<Star size={13} weight="regular" />}
          href="/skills"
          spark={totalSpark.length >= 2 ? <Sparkline points={totalSpark} color="#ffffff" /> : null}
        />
        <VividStatCard
          variant="conn"
          label="Connectors"
          value={connectorCount}
          icon={<PlugsConnected size={13} weight="regular" />}
          href="/connectors"
          meta={
            mcp.length > 0
              ? `${connectors.length} API · ${mcp.length} MCP`
              : `${connectors.length} API`
          }
          spark={totalSpark.length >= 2 ? <Sparkline points={totalSpark} color="#ffffff" /> : null}
        />
      </div>

      {/* Six metric cards (white) --------------------------------------- */}
      <div className="mt-3.5 grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-6">
        <MetricCard label="Total jobs" value={formatNumber(s.totalJobs)} />
        <MetricCard
          label="Success rate"
          value={successRate === null ? '—' : String(successRate)}
          unit={successRate === null ? undefined : '%'}
          subtle={
            s.totalJobs > 0 ? `${s.statusCounts['completed'] ?? 0} / ${s.totalJobs}` : undefined
          }
        />
        <MetricCard label="Tool calls" value={formatNumber(s.totalToolCalls)} />
        <MetricCard
          label="Input tokens"
          value={formatTokens(s.totalInputTokens).value}
          unit={formatTokens(s.totalInputTokens).unit}
        />
        <MetricCard
          label="Output tokens"
          value={formatTokens(s.totalOutputTokens).value}
          unit={formatTokens(s.totalOutputTokens).unit}
        />
        <MetricCard
          label="Tokens / job"
          value={tokensPerJob === null ? '—' : formatNumber(tokensPerJob)}
        />
      </div>

      {/* Activity chart -------------------------------------------------- */}
      <HomeActivityChart weekly={weekly} />

      {/* Recent activity table ------------------------------------------ */}
      <div className="mt-[18px] overflow-hidden rounded-2xl border border-rule-2 bg-paper">
        <div className="flex items-start justify-between px-[18px] py-[18px]">
          <div>
            <div className="text-[16px] font-medium leading-[1.2] text-ink">Recent activity</div>
            <div className="mt-1 text-[12.5px] leading-[1.3] text-ink-3">
              {activity.length === 0
                ? 'No jobs yet — the table will fill as your agents run.'
                : `Most recent ${activity.length} ${activity.length === 1 ? 'run' : 'runs'} across the fleet`}
            </div>
          </div>
        </div>
        {activity.length > 0 && (
          <table className="w-full border-collapse">
            <thead>
              <tr>
                <Th>Agent</Th>
                <Th>Task</Th>
                <Th>Type</Th>
                <Th>When</Th>
                <Th align="right">Duration</Th>
                <Th align="right">Status</Th>
              </tr>
            </thead>
            <tbody>
              {activity.map((r) => (
                <tr key={r.jobId} className="border-b border-dashed border-rule-2 last:border-0">
                  <Td>
                    <div className="flex items-center gap-2.5">
                      <AgentAvatar name={r.agentName} imageUrl={r.agentAvatarUrl} />
                      <div className="min-w-0">
                        <div className="truncate text-[13px] font-medium leading-[1.2] text-ink">
                          {r.agentName}
                        </div>
                        <div className="truncate font-mono text-[10px] leading-none text-ink-4">
                          {r.agentSlug}
                        </div>
                      </div>
                    </div>
                  </Td>
                  <Td>
                    <div
                      className="line-clamp-1 max-w-[420px] text-[13px] text-ink-2"
                      title={r.task}
                    >
                      {r.task}
                    </div>
                  </Td>
                  <Td>
                    <TypeChip variant="agent" label="Agent" />
                  </Td>
                  <Td className="font-mono text-[11.5px] text-ink-3">{formatWhen(r.createdAt)}</Td>
                  <Td align="right" className="font-mono text-[11.5px] text-ink-3">
                    {formatDuration(r.durationMs)}
                  </Td>
                  <Td align="right">
                    <StatusPill variant={statusToVariant(r.status)} />
                  </Td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

// ─── Small presentational helpers ──────────────────────────────────────

function Th({ children, align = 'left' }: { children: React.ReactNode; align?: 'left' | 'right' }) {
  return (
    <th
      className={`border-b border-rule-2 px-[18px] pt-1.5 pb-2.5 font-mono text-[9.5px] font-normal uppercase tracking-[0.16em] text-ink-4 ${
        align === 'right' ? 'text-right' : 'text-left'
      }`}
    >
      {children}
    </th>
  );
}

function Td({
  children,
  align = 'left',
  className = '',
}: {
  children: React.ReactNode;
  align?: 'left' | 'right';
  className?: string;
}) {
  return (
    <td
      className={`px-[18px] py-3 align-middle text-[13px] leading-[1.3] text-ink-2 ${
        align === 'right' ? 'text-right' : ''
      } ${className}`}
    >
      {children}
    </td>
  );
}

function statusToVariant(status: string | null): StatusVariant {
  if (status === 'completed') return 'done';
  if (status === 'failed' || status === 'cancelled') return 'warn';
  if (
    status === 'processing' ||
    status === 'pending' ||
    status === 'awaiting_approval' ||
    status === 'awaiting_delegation'
  )
    return 'run';
  return 'idle';
}

function formatNumber(n: number): string {
  if (n < 1_000) return String(n);
  if (n < 1_000_000) return `${(n / 1_000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

function formatTokens(n: number): { value: string; unit?: string } {
  if (n < 1_000) return { value: String(n) };
  if (n < 1_000_000) return { value: (n / 1_000).toFixed(1), unit: 'k' };
  return { value: (n / 1_000_000).toFixed(1), unit: 'M' };
}

function formatDuration(ms: number | null): string {
  if (ms === null || ms === undefined) return '—';
  if (ms < 1_000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1_000).toFixed(1)}s`;
  return `${(ms / 60_000).toFixed(1)}m`;
}

function formatWhen(d: Date | null): string {
  if (!d) return '—';
  const date = typeof d === 'string' ? new Date(d) : d;
  return date.toLocaleString(undefined, {
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function getGreeting(): string {
  const h = new Date().getHours();
  if (h < 5) return 'Up late';
  if (h < 12) return 'Good morning';
  if (h < 18) return 'Good afternoon';
  return 'Good evening';
}
