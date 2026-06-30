import { listDelegationRunsAction, listAgentsAction } from '@/lib/actions.ts';
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

  return (
    <PageShell
      title="Runs"
      subtitle={`${jobs.length} recent run${jobs.length !== 1 ? 's' : ''}${
        agentId ? ' · filtered by agent' : ''
      }`}
    >
      <JobsRuns
        rows={jobs}
        agents={agents}
        error={!jobsResult.ok ? jobsResult.message : undefined}
      />
    </PageShell>
  );
}
