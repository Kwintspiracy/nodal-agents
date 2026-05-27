import {
  getEntityStatsAction,
  getActiveJobsByAgentAction,
  getWeeklyActivityAction,
} from '@/lib/actions.ts';
import MetricCard from '@/components/ui/MetricCard';
import StatusPill, { type StatusVariant } from '@/components/ui/StatusPill';
import AgentAvatar from '@/components/ui/AgentAvatar';
import ActiveAgentsPanel from './ActiveAgentsPanel.tsx';
import WeeklyActivityChart from './WeeklyActivityChart.tsx';

export const dynamic = 'force-dynamic';

// Human-friendly labels for the job status table at the bottom. Anything
// not in this map renders the raw status string — better than a fallback
// like "Unknown" that hides real data shape from the operator.
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

function formatDuration(ms: number | null): string {
  if (ms === null || ms === undefined) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60_000).toFixed(1)}m`;
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

export default async function StatsPage() {
  const [result, activeResult, weeklyResult] = await Promise.all([
    getEntityStatsAction(),
    getActiveJobsByAgentAction(),
    getWeeklyActivityAction(),
  ]);
  const initialActive = activeResult.ok ? activeResult.data : [];
  const weekly = weeklyResult.ok ? weeklyResult.data : [];

  if (!result.ok) {
    return (
      <div className="py-7">
        <h1 className="text-[28px] font-semibold tracking-[-0.015em] text-ink">Stats</h1>
        <div className="mt-4 rounded-xl border border-warn/40 bg-warn-bg p-5 text-sm text-warn">
          {result.message}
        </div>
      </div>
    );
  }

  const s = result.data;
  const totalTokens = s.totalInputTokens + s.totalOutputTokens;
  const successRate =
    s.totalJobs > 0 ? Math.round(((s.statusCounts['completed'] ?? 0) / s.totalJobs) * 100) : null;
  const tokensPerJob = s.totalJobs > 0 ? Math.round(totalTokens / s.totalJobs) : null;
  const inTok = formatTokens(s.totalInputTokens);
  const outTok = formatTokens(s.totalOutputTokens);

  return (
    <div className="py-7">
      <div className="mb-5">
        <h1 className="text-[28px] font-semibold leading-[1.15] tracking-[-0.015em] text-ink">
          Stats
        </h1>
        <p className="mt-1.5 text-[13px] leading-[1.5] text-ink-3">
          Workspace activity since the database was first seeded
        </p>
      </div>

      <ActiveAgentsPanel initial={initialActive} />

      <div className="mt-6">
        <WeeklyActivityChart data={weekly} />
      </div>

      {/* Stat strip — same metrics as Home, just expanded to all eight ----- */}
      <div className="mt-6 grid grid-cols-2 gap-2.5 sm:grid-cols-4 lg:grid-cols-8">
        <MetricCard label="Agents" value={String(s.agentCount)} />
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
          label="Avg duration"
          value={formatDuration(s.avgDurationMs)}
          subtle="completed jobs"
        />
        <MetricCard
          label="Input tokens"
          value={inTok.value}
          unit={inTok.unit}
          subtle={`${formatNumber(totalTokens)} total`}
        />
        <MetricCard label="Output tokens" value={outTok.value} unit={outTok.unit} />
        <MetricCard
          label="Tokens / job"
          value={tokensPerJob === null ? '—' : formatNumber(tokensPerJob)}
        />
      </div>

      {/* Job status table -------------------------------------------------- */}
      {Object.keys(s.statusCounts).length > 0 && (
        <div className="mt-7">
          <h2 className="mb-2 font-mono text-[10.5px] uppercase tracking-[0.16em] text-ink-4">
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

      {/* Per-agent table --------------------------------------------------- */}
      {s.perAgent.length > 0 && (
        <div className="mt-7">
          <h2 className="mb-2 font-mono text-[10.5px] uppercase tracking-[0.16em] text-ink-4">
            Per agent
          </h2>
          <div className="overflow-hidden rounded-2xl border border-rule-2 bg-paper">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-rule-2">
                  <th className="px-5 py-3 text-left font-mono text-[9.5px] font-normal uppercase tracking-[0.16em] text-ink-4">
                    Agent
                  </th>
                  <th className="px-5 py-3 text-right font-mono text-[9.5px] font-normal uppercase tracking-[0.16em] text-ink-4">
                    Jobs
                  </th>
                  <th className="hidden px-5 py-3 text-right font-mono text-[9.5px] font-normal uppercase tracking-[0.16em] text-ink-4 md:table-cell">
                    Input tk
                  </th>
                  <th className="hidden px-5 py-3 text-right font-mono text-[9.5px] font-normal uppercase tracking-[0.16em] text-ink-4 md:table-cell">
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
