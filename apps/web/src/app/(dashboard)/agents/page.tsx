import {
  listAgentsAction,
  listAgentGroupsAction,
  listLlmKeysAction,
  getActiveJobsByAgentAction,
} from '@/lib/actions.ts';
import AgentForm from '@/components/AgentForm.tsx';
import PageShell from '@/components/ui/PageShell';
import PageTopBar from '@/components/ui/PageTopBar';
import AgentsErrorRetry from './AgentsErrorRetry.tsx';
import AgentsList from './AgentsList.tsx';

// Force dynamic rendering — this page reads per-request DB state. Without
// this, Next.js may statically render at build time (with the placeholder
// DATABASE_URL from env.ts) and serve cached error HTML at runtime.
export const dynamic = 'force-dynamic';

export default async function AgentsPage() {
  // listAgentsAction is still needed for the AgentForm picker (sub-agent
  // selection while editing a team) — keep loading it alongside the grouped
  // view used by AgentsList. Active jobs feed the per-row live activity
  // badges; AgentsList re-polls client-side to keep them fresh.
  const [groupsResult, listResult, llmKeysResult, activityResult] = await Promise.all([
    listAgentGroupsAction(),
    listAgentsAction(),
    listLlmKeysAction(),
    getActiveJobsByAgentAction(),
  ]);
  const llmKeys = llmKeysResult.ok ? llmKeysResult.data : [];
  const flatAgents = listResult.ok ? listResult.data : [];
  const initialActivity = activityResult.ok ? activityResult.data : [];
  // Count distinct agents across all groups (a worker assigned to multiple
  // orchestrators appears in each group, but we want the unique total).
  const totalAgents = flatAgents.length;

  return (
    <PageShell
      title="Agents"
      subtitle={groupsResult.ok ? `${totalAgents} agent${totalAgents !== 1 ? 's' : ''}` : undefined}
      toolbar={<PageTopBar cta={<AgentForm llmKeys={llmKeys} agents={flatAgents} />} />}
    >
      {!groupsResult.ok ? (
        <AgentsErrorRetry message={groupsResult.message} />
      ) : (
        <AgentsList
          initialGroups={groupsResult.data}
          initialActivity={initialActivity}
          agents={flatAgents}
          llmKeys={llmKeys}
        />
      )}
    </PageShell>
  );
}
