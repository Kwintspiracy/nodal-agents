// delegation-tools.ts — the delegation tools a job holds, decided in one place.
//
// The orchestrator role ADDS delegation (#636): `assign_*` for one in-line
// hand-off, `create_task` / `list_tasks` for the task board. Both routes reach
// the same agents, the active members of the team (reach.ts, #473). The runner's
// whitelist (apps/runner/src/job/execute.ts §6) and the list the Tools tab and
// the routine checks read (apps/runner/src/job/resolve-agent-tools.ts) both
// call this function, and the team block's delegation manual — where the
// delegation scope rule is said, once — is written on the same conditions
// (team-block.ts): a role that delegates, hops left, and a team.

import { remainingDelegationHops } from './chain-counters';
import { generateAssignTools } from './router/assign-tools';
import { generateTaskTools } from './planner/task-tools';
import type { AgentId, AnyDrizzleDb } from './types';

type AssignTool = Awaited<ReturnType<typeof generateAssignTools>>[number];
type TaskTool = ReturnType<typeof generateTaskTools>[number];

/**
 * The delegation tools of a job of `agentId`: none for a role that does not
 * delegate, none at the maximum delegation depth (invariant #8), and none when
 * the agent has no active teammate — neither route has anyone to reach, and a
 * `create_task` without a team could only fail or leave a task nobody picks up.
 */
export async function generateDelegationTools(
  agentId: AgentId,
  db: AnyDrizzleDb,
  opts: { isOrchestrator: boolean; delegationDepth: number },
): Promise<Array<AssignTool | TaskTool>> {
  if (!opts.isOrchestrator || remainingDelegationHops(opts.delegationDepth) === 0) return [];
  const assign = await generateAssignTools(agentId, db);
  if (assign.length === 0) return [];
  return [...assign, ...generateTaskTools(agentId, db)];
}
