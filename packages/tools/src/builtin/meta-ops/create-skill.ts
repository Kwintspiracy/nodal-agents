// meta-ops/create-skill.ts — create_skill meta-tool
// Lets the ROOT agent create new entity-owned skills via natural language.
// riskLevel 'write': additive, not destructive.

import { z } from 'zod';
import { createSkillRepo } from '@nodal-agents/db';
import type { ToolDefinition } from '../../types';
import { lintSkillContent } from './lint-skill-content';

/** Authoring guidance appended to create_skill / update_skill descriptions so
 *  the LLM writes skills against NodalAI's real conventions, not its
 *  Claude-Desktop / Cursor training prior. */
export const SKILL_AUTHORING_GUIDE =
  ' AUTHORING FOR NODALAI: a skill is a prompt fragment for an agent running on THIS platform. ' +
  'Reference tools by their NodalAI names only — MCP tools are "<server-slug>__<tool>" ' +
  '(e.g. "airtable__list_records_for_table", "apify__apify--rag-web-browser"); built-in and ' +
  'connector tools are bare snake_case (e.g. "save_memory"). There is NO "mcp__…" prefix and no ' +
  'Claude-Desktop / Cursor / Claude-in-Chrome tooling here. If you adapt an example from another ' +
  'platform, TRANSLATE its tool names to NodalAI. Prefer DISCOVERING schemas at runtime ' +
  '(list tables/fields) over hardcoding IDs that go stale. Do not invent tool names — references ' +
  'to tools that do not exist in this workspace are rejected.';

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
    'slug must be lowercase alphanumeric + hyphens. Fails with an error if the slug is already taken.' +
    SKILL_AUTHORING_GUIDE,
  inputSchema: CreateSkillInput,
  riskLevel: 'write',
  execute: async (input, ctx) => {
    // Reject foreign/invented tool references before persisting (fail loud).
    const lint = await lintSkillContent(ctx.db, ctx.entityId, input.content);
    if (!lint.ok) {
      return { ok: false, error: lint.error };
    }

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
