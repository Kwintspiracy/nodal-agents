// Built-in: skill_view
// Read the full content of a skill by slug — the just-in-time loader for tool
// usage guides. Tool usage skills (e.g. `tool-create-mcp`) are seeded but NOT
// auto-injected into the prompt (that would bloat context); an agent calls
// skill_view RIGHT BEFORE using a tool to load its exact format + examples.
// Mirrors how Hermes exposes `skill_view`. Entity-scoped, read-only.

import { z } from 'zod';
import { agentSkills, eq, and } from '@nodal-agents/db';
import type { ToolDefinition } from '../types';

export const SkillViewInputSchema = z.object({
  slug: z
    .string()
    .min(1)
    .describe('Slug of the skill to read, e.g. "tool-create-mcp" or "tool-create-agent".'),
});

export type SkillViewInput = z.infer<typeof SkillViewInputSchema>;

type SkillViewOutput = { ok: true; name: string; content: string } | { ok: false; error: string };

export const skillViewTool: ToolDefinition<typeof SkillViewInputSchema, SkillViewOutput> = {
  name: 'skill_view',
  description:
    "Read a skill's full content by slug. Use it to load a tool's usage guide right before you " +
    "call that tool — e.g. skill_view('tool-create-mcp') just before create_mcp. The guide gives " +
    'the exact format, a working example, and common mistakes, so you get the call right first try.',
  inputSchema: SkillViewInputSchema,
  riskLevel: 'read',
  execute: async (input, ctx) => {
    const [row] = await ctx.db
      .select({ name: agentSkills.name, content: agentSkills.content })
      .from(agentSkills)
      .where(and(eq(agentSkills.entityId, ctx.entityId), eq(agentSkills.slug, input.slug)));
    if (!row) return { ok: false, error: `No skill found with slug "${input.slug}".` };
    return { ok: true, name: row.name, content: row.content ?? '' };
  },
};
