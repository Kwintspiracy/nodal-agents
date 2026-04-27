// team-block.ts — auto-generate the ## Your team prompt section from DB
// Invariant 1: ZERO hardcoded agent slugs/names/metadata in this file.
// Every agent name, slug, skill, instruction comes from DB at runtime.

import { eq, and } from '@nodalai/db';
import { agents, agentAssignments, agentSkillAssignments, agentSkills } from '@nodalai/db';
import type { AgentId, AnyDrizzleDb } from './types.js';
import { detectOrchestratorMode } from './orchestrator-mode.js';

// ─── buildTeamBlock ───────────────────────────────────────────────────────────

/**
 * Build the `## Your team` section for an orchestrator's system prompt.
 *
 * The content is generated entirely from DB state:
 * - Children come from agent_assignments JOIN agents (active only)
 * - Skills come from agent_skill_assignments JOIN agent_skills
 * - Instructions come from agent_assignments.instructions
 *
 * Returns '' if the agent has no active children (worker mode — no team block needed).
 *
 * @param parentAgentId  The orchestrator agent's ID
 * @param db             Drizzle DB handle
 */
export async function buildTeamBlock(parentAgentId: AgentId, db: AnyDrizzleDb): Promise<string> {
  // Load children from DB
  const childRows = await db
    .select({
      subAgentId: agentAssignments.subAgentId,
      instructions: agentAssignments.instructions,
      agentName: agents.name,
      agentSlug: agents.slug,
      agentRole: agents.role,
      agentActive: agents.active,
    })
    .from(agentAssignments)
    .innerJoin(agents, eq(agentAssignments.subAgentId, agents.id))
    .where(
      and(eq(agentAssignments.orchestratorId, parentAgentId as string), eq(agents.active, true)),
    );

  if (childRows.length === 0) return '';

  // Detect mode: router (has sub-orchestrators) or planner (workers only)
  const parentRow = await db
    .select({ role: agents.role, orchestratorMode: agents.orchestratorMode })
    .from(agents)
    .where(eq(agents.id, parentAgentId as string))
    .limit(1);

  const parent = parentRow[0];
  if (!parent) return '';

  const childrenForMode = childRows.map((r) => ({
    role: r.agentRole as 'agent' | 'orchestrator' | 'system',
  }));

  const mode = detectOrchestratorMode(
    {
      role: parent.role as 'agent' | 'orchestrator' | 'system',
      orchestratorMode: parent.orchestratorMode as 'router' | 'planner' | null,
    },
    childrenForMode,
  );

  // Load skill assignments for all children
  const childIds = childRows.map((r) => r.subAgentId);
  const skillRows = await Promise.all(
    childIds.map((id) =>
      db
        .select({
          agentId: agentSkillAssignments.agentId,
          skillName: agentSkills.name,
          skillSlug: agentSkills.slug,
        })
        .from(agentSkillAssignments)
        .innerJoin(agentSkills, eq(agentSkillAssignments.skillId, agentSkills.id))
        .where(eq(agentSkillAssignments.agentId, id as string)),
    ),
  );

  const skillMap = new Map<string, string[]>();
  for (const batch of skillRows) {
    for (const r of batch) {
      const existing = skillMap.get(r.agentId) ?? [];
      existing.push(r.skillName);
      skillMap.set(r.agentId, existing);
    }
  }

  // Build lines array (all data from DB — no hardcoded names)
  const lines: string[] = [];

  if (mode === 'router') {
    lines.push('## Your team\n');
    lines.push(
      'You are a **router orchestrator**. Route requests to the right sub-agent using their `assign_*` tool.\n',
    );
    for (const row of childRows) {
      const { subAgentId, agentName, agentSlug, agentRole, instructions } = row;
      const toolSlug = agentSlug.replace(/-/g, '_');
      const skills = skillMap.get(subAgentId) ?? [];
      const skillsTag = skills.length > 0 ? `\n  Skills: ${skills.join(', ')}` : '';
      const roleTag = agentRole === 'orchestrator' ? ' (orchestrator)' : '';
      const instrTag = instructions ? `\n  Instructions: ${instructions}` : '';
      lines.push(
        `- **${agentName}**${roleTag} — use \`assign_${toolSlug}\` to assign work${skillsTag}${instrTag}`,
      );
    }
  } else {
    // planner
    lines.push('## Your team\n');
    lines.push(
      'You are a **planning orchestrator**. Create tasks using `create_task` and assign them to agents.\n',
    );
    for (const row of childRows) {
      const { subAgentId, agentName, agentSlug, agentRole, instructions } = row;
      const skills = skillMap.get(subAgentId) ?? [];
      const skillsTag = skills.length > 0 ? `\n  Skills: ${skills.join(', ')}` : '';
      const roleTag = agentRole === 'orchestrator' ? ' (orchestrator)' : '';
      const instrTag = instructions ? `\n  Instructions: ${instructions}` : '';
      lines.push(
        `- **${agentName}**${roleTag} (assigned_to: \`${agentSlug}\`)${skillsTag}${instrTag}`,
      );
    }
  }

  return lines.join('\n');
}
