// builtin-tool-names.ts — the BUILT-IN tool names a job of this agent is given.
//
// One rule, read from the database, for every caller that needs to know what
// an agent can actually call without running a job:
//   - the runner's `resolveAgentToolNames` (apps/runner/src/job/resolve-agent-
//     tools.ts), which adds connectors, MCP servers and delivery tools on top;
//   - the team block (team-block.ts), which tells an orchestrator whether a
//     teammate can run a shell command (#506).
//
// Before it was factored out, the team block recomputed "run_command is
// unlocked by a skill" on its own, and got orchestrators wrong: the
// orchestrator branch of the job whitelist (apps/runner/src/job/execute.ts,
// "Unified orchestrator") never adds the builtins a skill requires, so an
// orchestrator holding the command-execution skill still has no
// `run_command` — and the roster said it had one (Codex review of #506, P1).
//
// Mirrors execute.ts's per-job assembly for a fresh, non-delegated job; the
// fidelity notes of resolve-agent-tools.ts apply.

import { eq } from '@nodal-agents/db';
import { agents, entities, agentSkillAssignments, agentSkills } from '@nodal-agents/db';
import {
  createToolRegistry,
  registerBuiltins,
  computeToolWhitelist,
  ALWAYS_ON_TOOLS,
} from '@nodal-agents/tools';
import { metaToolsForAgent, parseRootGrants } from '@nodal-agents/shared';
import type { AnyDrizzleDb } from './types';

export interface BuiltinToolNames {
  isOrchestrator: boolean;
  /** Built-in tool names only: no assign_*, connector, MCP or delivery tool. */
  names: string[];
}

/**
 * The built-in tools a job of `agentId` receives. Throws for an unknown agent
 * (fail loud — a caller asking about an agent that does not exist has a bug).
 */
export async function resolveBuiltinToolNames(
  db: AnyDrizzleDb,
  agentId: string,
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

  const scriptToolNames = assignedSkillRows.some((r) => r.scriptsAuthorized === true)
    ? ['run_skill_script']
    : [];
  const fileWriteToolNames = assignedSkillRows.some((r) => r.filesWritable === true)
    ? ['skill_file_write']
    : [];

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

  // ── Orchestrator vs worker (mirrors execute.ts "Unified orchestrator") ───
  // The orchestrator branch takes the always-on set as is: the builtins a
  // skill requires are NOT added there, in execute.ts as here.
  if (isOrchestrator) {
    return {
      isOrchestrator,
      names: [
        ...new Set([
          ...ALWAYS_ON_TOOLS,
          ...metaToolNames,
          ...scriptToolNames,
          ...fileWriteToolNames,
        ]),
      ],
    };
  }

  const skillRequiredBuiltins = Array.from(
    new Set(assignedSkillRows.flatMap((r) => r.requiredBuiltins ?? [])),
  ).filter((name) => registry.get(name) !== undefined);

  const defs = computeToolWhitelist(
    {
      agentId: agentRow.id,
      configuredTools: [],
      alwaysOn: [
        ...ALWAYS_ON_TOOLS,
        ...skillRequiredBuiltins,
        ...metaToolNames,
        ...scriptToolNames,
        ...fileWriteToolNames,
      ],
    },
    registry,
  );
  return { isOrchestrator, names: [...new Set(defs.map((d) => d.name))] };
}
