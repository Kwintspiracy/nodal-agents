// router/assign-tools.ts — generate assign_* tools from DB
// Reads children from agent_assignments table. Never hardcodes agent slugs.

import { z } from 'zod';
import { eq, and } from '@nodalai/db';
import { agents, agentAssignments, agentSkillAssignments, agentSkills } from '@nodalai/db';
import { DelegationPendingError } from '../errors';
import type { AgentId, AnyDrizzleDb, ToolDefinition, ChildAgent } from '../types';

// ─── Input schema for every assign_* tool ────────────────────────────────────

const assignInputSchema = z.object({
  task: z.string().describe('What this agent should do. Be specific and complete.'),
  data: z
    .string()
    .optional()
    .describe(
      'Data from a previous step to pass to this agent (e.g. spreadsheet content, search results).',
    ),
});

export type AssignInput = z.infer<typeof assignInputSchema>;

// ─── generateAssignTools ──────────────────────────────────────────────────────

/**
 * Generate one `assign_<slug>` tool per child agent of `parentAgentId`.
 *
 * Children are read from `agent_assignments` + `agents` tables.
 * Tool names are always `assign_<slug>` where slug has hyphens replaced by
 * underscores (e.g. `email-bot` → `assign_email_bot`).
 *
 * Each tool's execute() creates the child job, then throws DelegationPendingError
 * to signal to the runner that the parent must suspend.
 *
 * The runner catches DelegationPendingError and calls handleDelegation() to:
 *   1. Suspend the parent job (awaiting_delegation)
 *   2. Store pending_delegation metadata
 *
 * @param parentAgentId  The orchestrator's agent ID
 * @param db             Drizzle DB handle
 * @returns              Array of ToolDefinition — one per active child
 */
export async function generateAssignTools(
  parentAgentId: AgentId,
  db: AnyDrizzleDb,
): Promise<ToolDefinition<typeof assignInputSchema, never>[]> {
  // Load children via agent_assignments JOIN agents
  const rows = await db
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

  if (rows.length === 0) return [];

  // Fetch skill names per agent for richer tool descriptions
  const childIds = rows.map((r) => r.subAgentId);
  const allSkillRows = await Promise.all(
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
  for (const skillBatch of allSkillRows) {
    for (const r of skillBatch) {
      const existing = skillMap.get(r.agentId) ?? [];
      existing.push(r.skillName);
      skillMap.set(r.agentId, existing);
    }
  }

  // Build one tool per child
  const tools: ToolDefinition<typeof assignInputSchema, never>[] = [];

  for (const row of rows) {
    const { subAgentId, instructions, agentName, agentSlug, agentRole } = row;

    // Normalize slug: hyphens → underscores for valid tool names
    const toolSlug = agentSlug.replace(/-/g, '_');
    const toolName = `assign_${toolSlug}`;

    // Build description from live DB data (never hardcoded)
    const skills = skillMap.get(subAgentId) ?? [];
    const skillsDesc = skills.length > 0 ? ` Skills: ${skills.join(', ')}.` : '';
    const roleNote = agentRole === 'orchestrator' ? ' (orchestrator — manages their own team)' : '';
    const instrNote = instructions ? ` Instructions: ${instructions}` : '';

    const description = `Assign a task to ${agentName}${roleNote}.${skillsDesc}${instrNote}`.trim();

    // Capture in closure
    const capturedSlug = agentSlug;

    const tool: ToolDefinition<typeof assignInputSchema, never> = {
      name: toolName,
      description,
      inputSchema: assignInputSchema,
      riskLevel: 'write',
      // execute() throws DelegationPendingError — the runner must intercept this
      // and call handleDelegation() to suspend the parent and create the child job.
      // The tool never actually returns a value; the signal IS the error.
      execute: async (input: AssignInput) => {
        // This execute is a sentinel — the runner intercepts DelegationPendingError
        // before it propagates. The child job ID will be set by handleDelegation().
        throw new DelegationPendingError(
          // placeholder — handleDelegation will override with the real child job ID
          `pending:${capturedSlug}`,
          capturedSlug,
        );

        // Unreachable — typed as `never` return
        return input as never;
      },
    };

    tools.push(tool);
  }

  return tools;
}

// ─── getChildAgents ───────────────────────────────────────────────────────────

/**
 * Load child agents for a parent orchestrator from the DB.
 * Used by buildTeamBlock and detectOrchestratorMode.
 */
export async function getChildAgents(
  parentAgentId: AgentId,
  db: AnyDrizzleDb,
): Promise<ChildAgent[]> {
  const rows = await db
    .select({
      id: agents.id,
      name: agents.name,
      slug: agents.slug,
      role: agents.role,
      active: agents.active,
    })
    .from(agentAssignments)
    .innerJoin(agents, eq(agentAssignments.subAgentId, agents.id))
    .where(
      and(eq(agentAssignments.orchestratorId, parentAgentId as string), eq(agents.active, true)),
    );

  return rows.map((r) => ({
    id: r.id as AgentId,
    name: r.name,
    slug: r.slug,
    role: r.role as 'agent' | 'orchestrator' | 'system',
    description: r.name, // will be enriched by team-block.ts
  }));
}
