// meta-ops/create-skill.ts — create_skill meta-tool
// Lets the ROOT agent create new entity-owned skills via natural language.
// riskLevel 'write': additive, not destructive.

import { z } from 'zod';
import { createSkillRepo } from '@nodal-agents/db';
import type { ToolDefinition } from '../../types';

const CreateSkillInput = z.object({
  slug: z
    .string()
    .regex(/^[a-z0-9-]+$/, 'Slug must be lowercase alphanumeric with hyphens only.')
    .min(1)
    .describe('URL-safe identifier for the skill (e.g. "customer-support-v2").'),
  name: z.string().min(1).describe('Human-readable display name for the skill.'),
  content: z
    .string()
    .min(1)
    .describe('The skill instructions injected into the agent system prompt when assigned.'),
  description: z.string().optional().describe('Optional short description of what the skill does.'),
});

type CreateSkillOutput = { ok: true; message: string } | { ok: false; error: string };

export const createSkillTool: ToolDefinition<typeof CreateSkillInput, CreateSkillOutput> = {
  name: 'create_skill',
  description:
    'Create a new skill for this entity. The skill can then be assigned to agents via attach_skill. ' +
    'slug must be lowercase alphanumeric + hyphens. Fails with an error if the slug is already taken.',
  inputSchema: CreateSkillInput,
  riskLevel: 'write',
  execute: async (input, ctx) => {
    const result = await createSkillRepo(ctx.db, ctx.entityId, {
      slug: input.slug,
      name: input.name,
      content: input.content,
      description: input.description,
    });

    if ('error' in result) {
      return {
        ok: false,
        error: `Skill slug "${input.slug}" is already taken. Choose a different slug.`,
      };
    }

    return {
      ok: true,
      message: `Created skill "${input.name}" (${input.slug}), id ${result.id}`,
    };
  },
};
