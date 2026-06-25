import {
  getEntityStatsAction,
  getActiveJobsByAgentAction,
  getWeeklyActivityAction,
  listSkillsAction,
  listConnectorsAction,
  listMcpServersAction,
} from '@/lib/actions.ts';
import VividStatCard from '@/components/ui/VividStatCard';
import MetricCard from '@/components/ui/MetricCard';
import StatusPill, { type StatusVariant } from '@/components/ui/StatusPill';
import AgentAvatar from '@/components/ui/AgentAvatar';
import ActiveAgentsPanel from './ActiveAgentsPanel.tsx';
import WeeklyActivityChart from './WeeklyActivityChart.tsx';
import { UsersThree, Star, PlugsConnected } from '@phosphor-icons/react/dist/ssr';

export const dynamic = 'force-dynamic';

/**
 * Dashboard root — merged Home + Stats surface.
 *
 * Layout, top to bottom:
 *   1. Greeting + one-line lede
 *   2. Three vivid section cards (Agents lime, Skills coral, Connectors blue)
 *   3. Six white MetricCards (Total jobs, Success rate, Tool calls,
 *      Input tokens, Output tokens, Tokens / job)
 *   4. Agents at work — live-polled panel of in-flight agents
 *   5. Weekly activity — 12-week stacked-bar chart of jobs by status
 *   6. Job status — breakdown by status
 *   7. Per agent — table of job counts + tokens
 *
 * There is no separate /stats page — that route was a leftover from before
 * the merge and is now removed. The dashboard root IS the stats view.
 *
 * Numbers not fabricated:
 *   - "+18.2% w/w" deltas omitted (no w/w aggregate)
 *   - "uptime %" omitted (no health log)
 *   - "needs auth" tally on Connectors meta omitted (no per-instance status)
 *   Cards keep their headline values; gaps stay honest.
 */
export default async function DashboardPage() {
  const [statsRes, activeRes, weeklyRes, skillsRes, connsRes, mcpRes] = await Promise.all([
    getEntityStatsAction(),
    getActiveJobsByAgentAction(),
    getWeeklyActivityAction(),
    listSkillsAction(),
    listConnectorsAction(),
    listMcpServersAction(),
  ]);

  if (!statsRes.ok) {
    return (
      <div className="py-7">
        <h1 className="text-[28px] font-semibold tracking-[-0.015em] text-ink">Dashboard</h1>
        <div className="mt-4 rounded-xl border border-warn/40 bg-warn-bg p-5 text-sm text-warn">
          {statsRes.message}
        </div>
      </div>
    );
  }

  const s = statsRes.data;
  const active = activeRes.ok ? activeRes.data : [];
  const weekly = weeklyRes.ok ? weeklyRes.data : { rows: [], models: [] };
  const skills = skillsRes.ok ? skillsRes.data : [];
  const connectors = connsRes.ok ? connsRes.data.instances : [];
  const mcp = mcpRes.ok ? mcpRes.data.instances : [];

  // Derived metrics — all from real aggregates, no synthesis.
  const runningCount = active.length;
  // Count skills actually IN USE (assigned to an agent in this workspace), to
  // mirror the connectors card (installed instances). The library/marketplace
  // skills that nobody has assigned shouldn't inflate this — they'd read like
  // "11 skills" on a fresh workspace where none are wired to an agent.
  const skillCount = skills.filter((sk) => sk.assignmentCount > 0).length;
  const connectorCount = connectors.length + mcp.length;
  const totalTokens = s.totalInputTokens + s.totalOutputTokens;
  const successRate =
    s.totalJobs > 0 ? Math.round(((s.statusCounts['completed'] ?? 0) / s.totalJobs) * 100) : null;
  const tokensPerJob = s.totalJobs > 0 ? Math.round(totalTokens / s.totalJobs) : null;

  // Greeting — local time-of-day.
  const greet = getGreeting();
  const todayLabel = new Date().toLocaleDateString(undefined, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  });

  return (
    <div className="py-7">
      {/* 0 — Greeting --------------------------------------------------- */}
      <div className="mb-5">
        <div className="flex flex-wrap items-baseline gap-3 text-[28px] font-semibold leading-[1.15] tracking-[-0.015em] text-ink">
          {greet}
          <span className="text-[14px] font-medium leading-none text-ink-3">{todayLabel}</span>
        </div>
        <div className="mt-1.5 text-[14px] leading-[1.5] text-ink-3">
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

      {/* 1 — Three vivid stat cards ------------------------------------ */}
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
        />
        <VividStatCard
          variant="skill"
          label="Skills"
          value={skillCount}
          icon={<Star size={13} weight="regular" />}
          href="/skills"
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
        />
      </div>

      {/* 2 — Six white metric cards ------------------------------------ */}
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

      {/* 3 — Agents at work (live-polled) ------------------------------ */}
      <div className="mt-7">
        <ActiveAgentsPanel initial={active} />
      </div>

      {/* 4 — Weekly activity ------------------------------------------ */}
      <div className="mt-7">
        <WeeklyActivityChart data={weekly.rows} models={weekly.models} />
      </div>

      {/* 5 — Job status breakdown -------------------------------------- */}
      {Object.keys(s.statusCounts).length > 0 && (
        <div className="mt-7">
          <h2 className="mb-2 font-mono text-[11px] uppercase tracking-[0.16em] text-ink-4">
            Job status
          </h2>
          <div className="overflow-hidden rounded-2xl border border-rule-2 bg-paper">
            <table className="w-full text-sm">
              <tbody>
                {Object.entries(s.statusCounts)
                  .sort((a, b) => b[1] - a[1])
                  .map(([status, count]) => (
                    <tr key={status} className="border-b border-rule-2 last:border-0">
                      <td className="px-5 py-3">
                        <StatusPill
                          variant={statusToVariant(status)}
                          label={STATUS_LABEL[status] ?? status}
                        />
                      </td>
                      <td className="px-5 py-3 text-right font-mono tabular-nums text-ink-2">
                        {count}
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* 6 — Per agent ------------------------------------------------- */}
      {s.perAgent.length > 0 && (
        <div className="mt-7">
          <h2 className="mb-2 font-mono text-[11px] uppercase tracking-[0.16em] text-ink-4">
            Per agent
          </h2>
          <div className="overflow-hidden rounded-2xl border border-rule-2 bg-paper">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-rule-2">
                  <th className="px-5 py-3 text-left font-mono text-[11px] font-normal whitespace-nowrap uppercase tracking-[0.16em] text-ink-4">
                    Agent
                  </th>
                  <th className="px-5 py-3 text-right font-mono text-[11px] font-normal whitespace-nowrap uppercase tracking-[0.16em] text-ink-4">
                    Jobs
                  </th>
                  <th className="hidden px-5 py-3 text-right font-mono text-[11px] font-normal whitespace-nowrap uppercase tracking-[0.16em] text-ink-4 md:table-cell">
                    Input tk
                  </th>
                  <th className="hidden px-5 py-3 text-right font-mono text-[11px] font-normal whitespace-nowrap uppercase tracking-[0.16em] text-ink-4 md:table-cell">
                    Output tk
                  </th>
                </tr>
              </thead>
              <tbody>
                {s.perAgent.map((a) => (
                  <tr key={a.agentId} className="border-b border-rule-2 last:border-0">
                    <td className="px-5 py-3">
                      <div className="flex items-center gap-2.5">
                        <AgentAvatar name={a.agentName} size="md" shape="round" />
                        <div className="min-w-0">
                          <span className="text-ink">{a.agentName}</span>
                          <span className="ml-2 font-mono text-xs text-ink-4">{a.agentSlug}</span>
                        </div>
                      </div>
                    </td>
                    <td className="px-5 py-3 text-right font-mono tabular-nums text-ink-2">
                      {a.jobCount}
                    </td>
                    <td className="hidden px-5 py-3 text-right font-mono tabular-nums text-ink-3 md:table-cell">
                      {formatNumber(a.inputTokens)}
                    </td>
                    <td className="hidden px-5 py-3 text-right font-mono tabular-nums text-ink-3 md:table-cell">
                      {formatNumber(a.outputTokens)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Small helpers ─────────────────────────────────────────────────────

const STATUS_LABEL: Record<string, string> = {
  pending: 'Pending',
  processing: 'Processing',
  completed: 'Completed',
  failed: 'Failed',
  awaiting_approval: 'Awaiting approval',
  awaiting_delegation: 'Awaiting delegation',
  cancelled: 'Cancelled',
};

function statusToVariant(status: string): StatusVariant {
  if (status === 'completed') return 'done';
  if (status === 'failed' || status === 'cancelled') return 'warn';
  if (status.startsWith('awaiting') || status === 'processing' || status === 'pending')
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

function getGreeting(): string {
  const h = new Date().getHours();
  if (h < 5) return 'Up late';
  if (h < 12) return 'Good morning';
  if (h < 18) return 'Good afternoon';
  return 'Good evening';
}
