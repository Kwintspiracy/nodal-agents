import {
  listAgentsAction,
  listAgentGroupsAction,
  getActiveJobsByAgentAction,
} from '@/lib/actions.ts';
import AgentsErrorRetry from './AgentsErrorRetry.tsx';
import AgentsList from './AgentsList.tsx';

// Force dynamic rendering — this page reads per-request DB state. Without
// this, Next.js may statically render at build time (with the placeholder
// DATABASE_URL from env.ts) and serve cached error HTML at runtime.
export const dynamic = 'force-dynamic';

export default async function AgentsPage() {
  // listAgentsAction supplies the flat list for AgentsList's grid dedup logic.
  // Active jobs seed the per-agent activity badges; AgentsList re-polls.
  // listLlmKeysAction is no longer needed here — the AgentForm trigger is now
  // inside AgentsList's PageTopBar CTA which navigates to /agents/new.
  const [groupsResult, listResult, activityResult] = await Promise.all([
    listAgentGroupsAction(),
    listAgentsAction(),
    getActiveJobsByAgentAction(),
  ]);
  const initialActivity = activityResult.ok ? activityResult.data : [];

  return (
    <div className="py-7">
      <h1 className="text-[28px] font-semibold leading-[1.15] tracking-[-0.015em] text-ink">
        Agents
      </h1>
      {listResult.ok && (
        <p className="mt-1.5 text-[13px] leading-[1.5] text-ink-3">
          {listResult.data.length} agent{listResult.data.length !== 1 ? 's' : ''}
        </p>
      )}

      {!groupsResult.ok ? (
        <div className="mt-4">
          <AgentsErrorRetry message={groupsResult.message} />
        </div>
      ) : (
        <AgentsList initialGroups={groupsResult.data} initialActivity={initialActivity} />
      )}
    </div>
  );
}
