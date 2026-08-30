import {
  listAgentsAction,
  listAgentGroupsAction,
  listLlmKeysAction,
  getActiveJobsByAgentAction,
  listMcpServersAction,
} from '@/lib/actions.ts';
import { recipeConnectorMeta } from '@/lib/recipe-connectors.ts';
import { MCP_CATALOG } from '@nodal-agents/shared';
import RecipePicker from '@/components/RecipePicker.tsx';
import { recipeSkillMeta, systemSkills } from '@nodal-agents/catalog';
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
  const [groupsResult, listResult, llmKeysResult, activityResult, mcpResult] = await Promise.all([
    listAgentGroupsAction(),
    listAgentsAction(),
    listLlmKeysAction(),
    getActiveJobsByAgentAction(),
    listMcpServersAction(),
  ]);
  const llmKeys = llmKeysResult.ok ? llmKeysResult.data : [];
  const flatAgents = listResult.ok ? listResult.data : [];
  const initialActivity = activityResult.ok ? activityResult.data : [];
  // Count distinct agents across all groups (a worker assigned to multiple
  // orchestrators appears in each group, but we want the unique total).
  const totalAgents = flatAgents.length;
  // Server-side: the profile panel needs skill names, not skill bodies.
  const skillMeta = recipeSkillMeta(systemSkills);
  // Which recommended connectors this workspace already has — the panel says
  // "ready" or "your move" per connector, and creation attaches the ready ones.
  const installedMcp = mcpResult.ok
    ? mcpResult.data.instances.filter((i) => i.active).map((i) => i.slug)
    : [];
  const connectorMeta = recipeConnectorMeta(MCP_CATALOG, installedMcp);

  return (
    <PageShell
      title="Agents"
      subtitle={groupsResult.ok ? `${totalAgents} agent${totalAgents !== 1 ? 's' : ''}` : undefined}
      toolbar={
        <PageTopBar
          cta={
            <RecipePicker
              llmKeys={llmKeys}
              agents={flatAgents}
              skillMeta={skillMeta}
              connectorMeta={connectorMeta}
            />
          }
        />
      }
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
