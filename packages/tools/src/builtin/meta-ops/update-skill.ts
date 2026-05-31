// meta-ops/update-skill.ts — update_skill meta-tool
// Lets the ROOT agent modify an existing entity-owned skill (content, name,
// description, active). The slug is immutable (it identifies the skill for
// assignments). riskLevel 'write': not destructive.

import { z } from 'zod';
import { eq, and, or, ilike, updateSkillRepo } from '@nodal-agents/db';
import { agentSkills } from '@nodal-agents/db';
import type { ToolDefinition } from '../../types';
import { lintSkillContent } from './lint-skill-content';
import { SKILL_AUTHORING_GUIDE } from './create-skill';

const UpdateSkillInput = z.object({
  skillSlug: z.string().min(1).describe('The slug OR name of the skill to update.'),
  name: z.string().min(1).optional().describe('New display name (optional).'),
  description: z.string().optional().describe('New short description (optional).'),
  content: z
    .string()
    .min(1)
    .optional()
    .describe('New skill instructions, replacing the current ones (optional).'),
  active: z.boolean().optional().describe('Enable (true) or disable (false) the skill (optional).'),
});

type UpdateSkillOutput = { ok: true; message: string } | { ok: false; error: string };

export const updateSkillTool: ToolDefinition<typeof UpdateSkillInput, UpdateSkillOutput> = {
  name: 'update_skill',
  description:
    'Update an existing skill in this entity (content, name, description, or active). ' +
    'Identify the skill by its slug OR name. The slug itself cannot be changed. ' +
    'Provide at least one field to change. Returns an error if the skill is not found.' +
    SKILL_AUTHORING_GUIDE,
  inputSchema: UpdateSkillInput,
  riskLevel: 'write',
  execute: async (input, ctx) => {
    if (
      input.name === undefined &&
      input.description === undefined &&
      input.content === undefined &&
      input.active === undefined
    ) {
      return {
        ok: false,
        error: 'Nothing to update: provide at least one of name, description, content, active.',
      };
    }

    // If the content changes, reject foreign/invented tool references first.
    if (input.content !== undefined) {
      const lint = await lintSkillContent(ctx.db, ctx.entityId, input.content);
      if (!lint.ok) return { ok: false, error: lint.error };
    }

    // Resolve skillSlug → skillId within this entity (slug OR name, like attach_skill).
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
        error: `Skill "${input.skillSlug}" not found in this entity. Use create_skill to make a new one.`,
      };
    }

    const result = await updateSkillRepo(ctx.db, ctx.entityId, skillRow.id, {
      name: input.name,
      description: input.description,
      content: input.content,
      active: input.active,
    });

    if ('error' in result) {
      return { ok: false, error: `Skill "${input.skillSlug}" not found in this entity.` };
    }

    return { ok: true, message: `Updated skill "${skillRow.name}" (${input.skillSlug}).` };
  },
};
