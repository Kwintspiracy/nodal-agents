// reach.ts — who an orchestrator can hand work to, as ONE rule for both routes.
//
// Issue #473 (jobs f37faca7 and d23e3bc9, over MCP). Asked twice for the same
// review, the root took the task board once and delegation once. The task
// board resolved `assigned_to` against the whole workspace; `assign_*` only
// exists for the team. So the first pass reached both reviewers, the second
// only one, and the root answered that the other "does not exist in this
// workspace" — it was on Lead's team.
//
// The rule now, for `assign_*` and `create_task` alike: an orchestrator hands
// work to the ACTIVE agents of its own team. Any other agent of the workspace
// exists and is named as such, with the team that holds it and the teammate
// through whom it can be reached — never denied, never reached by a side door.

import { eq } from '@nodal-agents/db';
import { agents, agentAssignments } from '@nodal-agents/db';
import type { AgentId, AnyDrizzleDb } from './types';

export interface OutsideAgent {
  id: string;
  name: string;
  slug: string;
  active: boolean;
  /** The orchestrators whose team holds this agent (active ones only). */
  holders: string[];
  /**
   * The agent of YOUR team through which this one is reached, following the
   * teams downward; null when no chain of teams leads to it from you.
   */
  through: { name: string; slug: string } | null;
}

export interface WorkspaceReach {
  /** The ids of the active agents of this orchestrator's own team. */
  team: ReadonlySet<string>;
  /** Every other agent of the workspace, the orchestrator itself excluded. */
  outside: OutsideAgent[];
}

/** Read the workspace's agents and teams, and place each relative to `orchestratorId`. */
export async function loadWorkspaceReach(
  orchestratorId: AgentId,
  db: AnyDrizzleDb,
): Promise<WorkspaceReach> {
  const [self] = await db
    .select({ entityId: agents.entityId })
    .from(agents)
    .where(eq(agents.id, orchestratorId as string))
    .limit(1);
  if (!self?.entityId) return { team: new Set(), outside: [] };

  const all = await db
    .select({ id: agents.id, name: agents.name, slug: agents.slug, active: agents.active })
    .from(agents)
    .where(eq(agents.entityId, self.entityId));
  const byId = new Map(all.map((a) => [a.id, a]));

  const links = await db
    .select({ from: agentAssignments.orchestratorId, to: agentAssignments.subAgentId })
    .from(agentAssignments)
    .where(eq(agentAssignments.entityId, self.entityId));

  // Only active agents hand or receive work: the same filter the assign_*
  // tools apply (assign-tools.ts).
  const isActive = (id: string): boolean => byId.get(id)?.active === true;
  const children = new Map<string, string[]>();
  const holders = new Map<string, string[]>();
  for (const l of links) {
    if (!isActive(l.from) || !isActive(l.to)) continue;
    children.set(l.from, [...(children.get(l.from) ?? []), l.to]);
    holders.set(l.to, [...(holders.get(l.to) ?? []), l.from]);
  }

  const team = new Set(children.get(orchestratorId as string) ?? []);

  // Breadth-first down the teams: each agent remembers the member of MY team
  // its chain starts with.
  const through = new Map<string, string>();
  const queue: string[] = [];
  for (const c of team) {
    through.set(c, c);
    queue.push(c);
  }
  while (queue.length > 0) {
    const n = queue.shift()!;
    for (const m of children.get(n) ?? []) {
      if (through.has(m) || m === orchestratorId) continue;
      through.set(m, through.get(n)!);
      queue.push(m);
    }
  }

  const outside: OutsideAgent[] = all
    .filter((a) => a.id !== orchestratorId && !team.has(a.id))
    .map((a) => {
      const hop = through.get(a.id);
      const hopRow = hop ? byId.get(hop) : undefined;
      return {
        id: a.id,
        name: a.name,
        slug: a.slug,
        active: a.active === true,
        holders: (holders.get(a.id) ?? []).map((h) => byId.get(h)?.name ?? h),
        through: hopRow ? { name: hopRow.name, slug: hopRow.slug } : null,
      };
    })
    .sort((x, y) => x.name.localeCompare(y.name));

  return { team, outside };
}

/**
 * How the reader of the clause can hand work on (Codex review of #473, P1-b):
 * - `delegate`: it holds `assign_*` / `create_task` (a job);
 * - `escalate`: it holds only `run_task`, and the job it starts delegates (chat);
 * - `none`: no delegation path at all (a coding-CLI session). The facts stay,
 *   the route goes: telling it to go through a teammate would be an order it
 *   cannot follow.
 */
export type ReachMeans = 'delegate' | 'escalate' | 'none';

/**
 * Where an agent outside the team stands, in one clause. The team block lists
 * it this way and create_task refuses with it — one wording for one rule.
 * LLM-channel text; it never reaches the user as is (invariant #2).
 */
export function describeOutsideAgent(a: OutsideAgent, means: ReachMeans): string {
  if (!a.active) return 'inactive: nobody can hand it work until it is reactivated';
  if (a.holders.length === 0) return 'on no team: nobody can hand it work until it is attached';
  const team = `on the team of ${a.holders.join(', ')}`;
  if (means === 'none') return team;
  if (!a.through) return `${team}, which no chain of your team reaches`;
  const via = `**${a.through.name}** (\`${a.through.slug}\`), one of your agents`;
  return means === 'escalate'
    ? `${team}; the job you start with \`run_task\` can reach it through ${via}`
    : `${team}; reach it through ${via}, by asking it to have this agent do the work`;
}
