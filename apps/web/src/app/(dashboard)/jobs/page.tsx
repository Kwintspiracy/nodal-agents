import { listJobsAction, listAgentsAction } from '@/lib/actions.ts';
import SendTaskForm from '@/components/SendTaskForm.tsx';
import RunsTable from './RunsTable.tsx';

// Force dynamic — this page reads per-request DB state.
export const dynamic = 'force-dynamic';

export default async function JobsPage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = searchParams ? await searchParams : {};
  const agentId = typeof params['agentId'] === 'string' ? params['agentId'] : null;

  const [jobsResult, agentsResult] = await Promise.all([
    listJobsAction({ limit: 50 }),
    listAgentsAction(),
  ]);
  const jobs = jobsResult.ok ? jobsResult.data : [];
  const agents = agentsResult.ok ? agentsResult.data : [];

  return (
    <div className="py-7">
      {/* Header */}
      <div className="mb-5 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-[28px] font-semibold leading-[1.15] tracking-[-0.015em] text-ink">
            Runs
          </h1>
          <p className="mt-1.5 text-[14px] leading-[1.5] text-ink-3">
            {jobs.length} recent run{jobs.length !== 1 ? 's' : ''}
            {agentId ? ' · filtered by agent' : ''}
          </p>
        </div>
        <SendTaskForm agents={agents} />
      </div>

      {/* Error state */}
      {!jobsResult.ok && (
        <div className="mb-4 rounded-xl border border-warn/40 bg-warn-bg p-4 text-[14px] text-warn">
          {jobsResult.message}
        </div>
      )}

      {/* Filter + table (client component — owns search & tab state) */}
      <RunsTable jobs={jobs} agents={agents} agentId={agentId} />
    </div>
  );
}
