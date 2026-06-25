import {
  listAgentsAction,
  listAgentGroupsAction,
  listLlmKeysAction,
  getActiveJobsByAgentAction,
} from '@/lib/actions.ts';
import AgentForm from '@/components/AgentForm.tsx';
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
    <div className="py-7">
      <div className="mb-5 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-[28px] font-semibold leading-[1.15] tracking-[-0.015em] text-ink">
            Agents
          </h1>
          {groupsResult.ok && (
            <p className="mt-1.5 text-[14px] leading-[1.5] text-ink-3">
              {totalAgents} agent{totalAgents !== 1 ? 's' : ''}
            </p>
          )}
        </div>
        <AgentForm llmKeys={llmKeys} agents={flatAgents} />
      </div>

      {!groupsResult.ok ? (
        <AgentsErrorRetry message={groupsResult.message} />
      ) : (
        <AgentsList initialGroups={groupsResult.data} initialActivity={initialActivity} />
      )}
    </div>
  );
}
