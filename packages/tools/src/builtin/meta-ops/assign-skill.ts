// meta-ops/assign-skill.ts — attach_skill meta-tool
// Lets the ROOT agent assign an existing skill to an existing agent.
// riskLevel 'write': additive, not destructive.

import { z } from 'zod';
import { eq, and, or, ilike, assignSkillRepo } from '@nodal-agents/db';
import { agentSkills, agents } from '@nodal-agents/db';
import type { ToolDefinition } from '../../types';

const AssignSkillInput = z.object({
  skillSlug: z
    .string()
    .min(1)
    .describe('The slug OR name of the skill to assign (e.g. "customer-support-v2").'),
  agentSlug: z.string().min(1).describe('The slug OR name of the agent to assign the skill to.'),
});

type AssignSkillOutput = { ok: true; message: string } | { ok: false; error: string };

export const assignSkillTool: ToolDefinition<typeof AssignSkillInput, AssignSkillOutput> = {
  name: 'attach_skill',
  description:
    'Assign an existing skill to an existing agent in this entity. ' +
    'Both skillSlug and agentSlug must already exist. Returns a clear error if either is not found. ' +
    'Idempotent: safe to call even if the skill is already assigned.',
  inputSchema: AssignSkillInput,
  riskLevel: 'write',
  defaultApproval: 'require_approval',
  execute: async (input, ctx) => {
    // Resolve skillSlug → skillId within this entity
    const [skillRow] = await ctx.db
      .select({ id: agentSkills.id, name: agentSkills.name })
      .from(agentSkills)
      .where(
        and(
          eq(agentSkills.entityId, ctx.entityId),
          or(eq(agentSkills.slug, input.skillSlug), ilike(agentSkills.name, input.skillSlug)),
        ),
      )
      .limit(1);

    if (!skillRow) {
      return {
        ok: false,
        error: `Skill "${input.skillSlug}" not found in this entity. Make sure it exists (use create_skill if needed).`,
      };
    }

    // Resolve agentSlug → agentId within this entity
    const [agentRow] = await ctx.db
      .select({ id: agents.id, name: agents.name })
      .from(agents)
      .where(
        and(
          eq(agents.entityId, ctx.entityId),
          or(eq(agents.slug, input.agentSlug), ilike(agents.name, input.agentSlug)),
        ),
      )
      .limit(1);

    if (!agentRow) {
      return {
        ok: false,
        error: `Agent "${input.agentSlug}" not found in this entity.`,
      };
    }

    // MVT: entity-owned skills only — pass [] for systemSkillSlugs.
    // System skill cross-entity access can be added in a future brique when needed.
    const result = await assignSkillRepo(
      ctx.db,
      ctx.entityId,
      { skillId: skillRow.id, agentId: agentRow.id },
      [],
    );

    if ('error' in result) {
      if (result.error === 'already_assigned') {
        return {
          ok: true,
          message: `Skill "${input.skillSlug}" is already assigned to agent "${input.agentSlug}" — no change needed.`,
        };
      }
      if (result.error === 'skill_not_found') {
        return { ok: false, error: `Skill "${input.skillSlug}" not accessible in this entity.` };
      }
      if (result.error === 'agent_not_found') {
        return { ok: false, error: `Agent "${input.agentSlug}" not found in this entity.` };
      }
    }

    return {
      ok: true,
      message: `Assigned skill "${input.skillSlug}" to agent "${input.agentSlug}".`,
    };
  },
};
