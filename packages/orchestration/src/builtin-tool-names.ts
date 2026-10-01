// builtin-tool-names.ts — the BUILT-IN tool names a job of this agent is given.
//
// One rule, read from the database, for every caller that needs to know what
// an agent can actually call without running a job:
//   - the runner's `resolveAgentToolNames` (apps/runner/src/job/resolve-agent-
//     tools.ts), which adds connectors, MCP servers, delivery and delegation
//     tools on top;
//   - the team block (team-block.ts), which tells an orchestrator whether a
//     teammate can run a shell command (#506).
//
// The rule itself is `agentBuiltinToolNames` (tools), the very function the
// runner's job whitelist calls (apps/runner/src/job/execute.ts §6): this file
// only reads its inputs from the database. It used to mirror an orchestrator
// branch of the whitelist that skipped the tool groups, and copied that
// omission — an orchestrator holding command-execution was said to have no
// shell, and had none (#636).
//
// Computed for the job placement the caller names (a routine run for the
// routine lint), a fresh top-level job by default — the fidelity notes of
// resolve-agent-tools.ts apply.

import { eq } from '@nodal-agents/db';
import { agents, entities, agentSkillAssignments, agentSkills } from '@nodal-agents/db';
import {
  createToolRegistry,
  registerBuiltins,
  agentBuiltinToolNames,
  TOP_LEVEL_JOB,
  type JobPlacement,
} from '@nodal-agents/tools';
import { metaToolsForAgent, parseRootGrants } from '@nodal-agents/shared';
import type { AnyDrizzleDb } from './types';

let registered: ReadonlySet<string> | null = null;

/**
 * Every built-in tool name this build registers, gated ones included. A name
 * outside it is not a builtin: `agentBuiltinToolNames` never grants it through
 * a tool group, whatever `required_builtins` says.
 */
export function registeredBuiltinNames(): ReadonlySet<string> {
  if (!registered) {
    const registry = createToolRegistry();
    registerBuiltins(registry);
    registered = new Set(registry.list().map((t) => t.name));
  }
  return registered;
}

export interface BuiltinToolNames {
  isOrchestrator: boolean;
  /** Built-in tool names only: no assign_*, connector, MCP or delivery tool. */
  names: string[];
}

/**
 * The built-in tools a job of `agentId` receives, placed as `job` says. Throws
 * for an unknown agent (fail loud — a caller asking about an agent that does
 * not exist has a bug).
 */
export async function resolveBuiltinToolNames(
  db: AnyDrizzleDb,
  agentId: string,
  job: JobPlacement = TOP_LEVEL_JOB,
): Promise<BuiltinToolNames> {
  const registry = createToolRegistry();
  registerBuiltins(registry);

  const [agentRow] = await db
    .select({
      id: agents.id,
      role: agents.role,
      entityId: agents.entityId,
      mayChangeTeam: agents.mayChangeTeam,
    })
    .from(agents)
    .where(eq(agents.id, agentId))
    .limit(1);
  if (!agentRow) throw new Error(`resolveBuiltinToolNames: agent ${agentId} not found`);

  const isOrchestrator = agentRow.role === 'orchestrator';

  // ── Skill assignments (mirrors execute.ts §3.6) ──────────────────────────
  const assignedSkillRows = await db
    .select({
      requiredBuiltins: agentSkills.requiredBuiltins,
      scriptsAuthorized: agentSkillAssignments.scriptsAuthorized,
      filesWritable: agentSkillAssignments.filesWritable,
    })
    .from(agentSkillAssignments)
    .innerJoin(agentSkills, eq(agentSkills.id, agentSkillAssignments.skillId))
    .where(eq(agentSkillAssignments.agentId, agentRow.id));

  // ── Root meta-tool gating (mirrors execute.ts) ───────────────────────────
  const [entityRow] = await db
    .select({ rootAgentId: entities.rootAgentId, rootGrants: entities.rootGrants })
    .from(entities)
    .where(eq(entities.id, agentRow.entityId ?? ''))
    .limit(1);
  const isRootAgent = entityRow?.rootAgentId != null && entityRow.rootAgentId === agentRow.id;
  // `may_change_team` retire les trois outils d'équipe tant qu'il est à false
  // (issue #137), au même endroit de l'assemblage qu'execute.ts.
  const metaToolNames = isRootAgent
    ? metaToolsForAgent(parseRootGrants(entityRow?.rootGrants), {
        mayChangeTeam: agentRow.mayChangeTeam,
      }).filter((name) => registry.get(name) !== undefined)
    : [];

  return {
    isOrchestrator,
    names: agentBuiltinToolNames(
      {
        requiredBuiltins: assignedSkillRows.flatMap((r) => r.requiredBuiltins ?? []),
        scriptsAuthorized: assignedSkillRows.some((r) => r.scriptsAuthorized === true),
        filesWritable: assignedSkillRows.some((r) => r.filesWritable === true),
        metaToolNames,
        job,
      },
      registry,
    ),
  };
}
