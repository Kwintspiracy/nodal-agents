// meta-ops/detach-skill.ts — detach_skill meta-tool
// Removes a skill from an agent (deletes the agent_skill_assignments link).
// riskLevel 'write': reversible (re-attach with attach_skill).

import { z } from 'zod';
import { eq, and, agentSkillAssignments } from '@nodal-agents/db';
import type { ToolDefinition } from '../../types';
import { resolveAgentId, resolveSkillId } from './link-helpers';

const DetachSkillInput = z.object({
  skillSlug: z.string().min(1).describe('Slug or name of the skill to remove from the agent.'),
  agentSlug: z.string().min(1).describe('Slug or name of the agent to remove the skill from.'),
});

type DetachSkillOutput = { ok: true; message: string } | { ok: false; error: string };

export const detachSkillTool: ToolDefinition<typeof DetachSkillInput, DetachSkillOutput> = {
  name: 'detach_skill',
  description:
    'Remove a skill from an agent (un-assign it). Reversible with attach_skill. ' +
    'Idempotent: ok even if the skill was not assigned.',
  inputSchema: DetachSkillInput,
  riskLevel: 'write',
  card: 'text',
  defaultApproval: 'require_approval',
  execute: async (input, ctx) => {
    const skillId = await resolveSkillId(ctx.db, ctx.entityId, input.skillSlug);
    if (!skillId)
      return { ok: false, error: `Skill "${input.skillSlug}" not found in this workspace.` };
    const agentId = await resolveAgentId(ctx.db, ctx.entityId, input.agentSlug);
    if (!agentId)
      return { ok: false, error: `Agent "${input.agentSlug}" not found in this workspace.` };
    await ctx.db
      .delete(agentSkillAssignments)
      .where(
        and(eq(agentSkillAssignments.agentId, agentId), eq(agentSkillAssignments.skillId, skillId)),
      );
    return {
      ok: true,
      message: `Removed skill "${input.skillSlug}" from agent "${input.agentSlug}".`,
    };
  },
};
