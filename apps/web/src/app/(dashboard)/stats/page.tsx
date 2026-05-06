import { getEntityStatsAction } from '@/lib/actions.ts';

export const dynamic = 'force-dynamic';

const STATUS_LABEL: Record<string, string> = {
  pending: 'Pending',
  processing: 'Processing',
  completed: 'Completed',
  failed: 'Failed',
  awaiting_approval: 'Awaiting approval',
  awaiting_delegation: 'Awaiting delegation',
};

const STATUS_COLOR: Record<string, string> = {
  completed: 'text-emerald-400',
  failed: 'text-red-400',
  processing: 'text-blue-400',
  pending: 'text-amber-400',
  awaiting_approval: 'text-amber-400',
  awaiting_delegation: 'text-amber-400',
};

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

export default async function StatsPage() {
  const result = await getEntityStatsAction();

  if (!result.ok) {
    return (
      <div className="space-y-6 max-w-5xl">
        <h1 className="text-2xl font-bold text-white">Stats</h1>
        <div className="bg-neutral-900 border border-red-900/40 rounded-xl px-6 py-8 text-sm text-red-300">
          {result.message}
        </div>
      </div>
    );
  }

  const s = result.data;
  const totalTokens = s.totalInputTokens + s.totalOutputTokens;
  const successRate =
    s.totalJobs > 0 ? Math.round(((s.statusCounts['completed'] ?? 0) / s.totalJobs) * 100) : null;

  return (
    <div className="space-y-6 max-w-5xl">
      <div>
        <h1 className="text-2xl font-bold text-white">Stats</h1>
        <p className="text-sm text-neutral-500 mt-0.5">
          Workspace activity since the database was first seeded
        </p>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Card label="Agents" value={String(s.agentCount)} />
        <Card label="Total jobs" value={formatNumber(s.totalJobs)} />
        <Card
          label="Success rate"
          value={successRate === null ? '—' : `${successRate}%`}
          subtle={
            s.totalJobs > 0 ? `${s.statusCounts['completed'] ?? 0} / ${s.totalJobs}` : undefined
          }
        />
        <Card label="Tool calls" value={formatNumber(s.totalToolCalls)} />
        <Card
          label="Avg duration"
          value={formatDuration(s.avgDurationMs)}
          subtle="completed jobs"
        />
        <Card
          label="Input tokens"
          value={formatNumber(s.totalInputTokens)}
          subtle={`${formatNumber(totalTokens)} total`}
        />
        <Card label="Output tokens" value={formatNumber(s.totalOutputTokens)} />
        <Card
          label="Tokens / job"
          value={s.totalJobs > 0 ? formatNumber(Math.round(totalTokens / s.totalJobs)) : '—'}
        />
      </div>

      {Object.keys(s.statusCounts).length > 0 && (
        <div>
          <h2 className="text-xs font-semibold text-neutral-400 uppercase tracking-wider mb-2">
            Job status
          </h2>
          <div className="bg-neutral-900 border border-neutral-800/60 rounded-xl overflow-hidden">
            <table className="w-full text-sm">
              <tbody>
                {Object.entries(s.statusCounts)
                  .sort((a, b) => b[1] - a[1])
                  .map(([status, count]) => (
                    <tr key={status} className="border-b border-neutral-800/40 last:border-0">
                      <td className="px-5 py-3">
                        <span className={STATUS_COLOR[status] ?? 'text-neutral-300'}>
                          {STATUS_LABEL[status] ?? status}
                        </span>
                      </td>
                      <td className="px-5 py-3 text-right text-neutral-300 font-mono">{count}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {s.perAgent.length > 0 && (
        <div>
          <h2 className="text-xs font-semibold text-neutral-400 uppercase tracking-wider mb-2">
            Per agent
          </h2>
          <div className="bg-neutral-900 border border-neutral-800/60 rounded-xl overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-neutral-800/60">
                  <th className="text-left px-5 py-3 text-xs text-neutral-500 font-semibold uppercase tracking-wider">
                    Agent
                  </th>
                  <th className="text-right px-5 py-3 text-xs text-neutral-500 font-semibold uppercase tracking-wider">
                    Jobs
                  </th>
                  <th className="text-right px-5 py-3 text-xs text-neutral-500 font-semibold uppercase tracking-wider hidden md:table-cell">
                    Input tk
                  </th>
                  <th className="text-right px-5 py-3 text-xs text-neutral-500 font-semibold uppercase tracking-wider hidden md:table-cell">
                    Output tk
                  </th>
                </tr>
              </thead>
              <tbody>
                {s.perAgent.map((a) => (
                  <tr key={a.agentId} className="border-b border-neutral-800/40 last:border-0">
                    <td className="px-5 py-3">
                      <span className="text-white">{a.agentName}</span>
                      <span className="ml-2 font-mono text-xs text-neutral-500">{a.agentSlug}</span>
                    </td>
                    <td className="px-5 py-3 text-right text-neutral-300 font-mono">
                      {a.jobCount}
                    </td>
                    <td className="hidden md:table-cell px-5 py-3 text-right text-neutral-400 font-mono">
                      {formatNumber(a.inputTokens)}
                    </td>
                    <td className="hidden md:table-cell px-5 py-3 text-right text-neutral-400 font-mono">
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

function Card({ label, value, subtle }: { label: string; value: string; subtle?: string }) {
  return (
    <div className="bg-neutral-900 border border-neutral-800/60 rounded-xl px-4 py-3">
      <div className="text-[10px] uppercase tracking-wider text-neutral-500">{label}</div>
      <div className="text-2xl font-bold text-white mt-1 tabular-nums">{value}</div>
      {subtle && <div className="text-xs text-neutral-600 mt-0.5">{subtle}</div>}
    </div>
  );
}
