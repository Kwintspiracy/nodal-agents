import { listDelegationRunsAction, listAgentsAction } from '@/lib/actions.ts';
import { groupJobsForJobsPage } from '@/lib/jobs-grouping.ts';
import PageShell from '@/components/ui/PageShell';
import JobsRuns from './JobsRuns.tsx';

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
    listDelegationRunsAction({ limit: 50, agentId }),
    listAgentsAction(),
  ]);
  const jobs = jobsResult.ok ? jobsResult.data : [];
  const agents = agentsResult.ok ? agentsResult.data : [];
  // Conversation grouping (migration 0059): collapse chat exchanges sharing a
  // conversation_id into one row server-side, before anything reaches the
  // client — see apps/web/src/lib/jobs-grouping.ts.
  const rows = groupJobsForJobsPage(jobs);

  return (
    <PageShell
      title="Runs"
      subtitle={`${jobs.length} recent run${jobs.length !== 1 ? 's' : ''}${
        agentId ? ' · filtered by agent' : ''
      }`}
    >
      <JobsRuns
        rows={rows}
        agents={agents}
        error={!jobsResult.ok ? jobsResult.message : undefined}
      />
    </PageShell>
  );
}
