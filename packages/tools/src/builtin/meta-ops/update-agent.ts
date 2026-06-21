// meta-ops/update-agent.ts — update_agent meta-tool
// Lets the ROOT agent edit an EXISTING agent: model, personality, display name.
// riskLevel 'write': mutates but is reversible (not destructive).
//
// The `model` is validated against the curated catalog for the agent's provider
// (see agent-model.ts) so a wrong id fails loud instead of being saved silently.

import { z } from 'zod';
import { eq, and, agents } from '@nodal-agents/db';
import type { ToolDefinition } from '../../types';
import { resolveAgentProvider, validateModelForProvider } from './agent-model';

const UpdateAgentInput = z.object({
  slug: z.string().min(1).describe('Slug of the existing agent to edit (e.g. "java").'),
  model: z
    .string()
    .min(1)
    .optional()
    .describe(
      "New LLM model id. Must be valid for the agent's provider — call list_models first to get the exact id.",
    ),
  personality: z
    .string()
    .min(1)
    .optional()
    .describe('New system prompt / personality for the agent.'),
  name: z.string().min(1).optional().describe('New human-readable display name.'),
});

type UpdateAgentOutput = { ok: true; message: string } | { ok: false; error: string };

export const updateAgentTool: ToolDefinition<typeof UpdateAgentInput, UpdateAgentOutput> = {
  name: 'update_agent',
  description:
    'Edit an EXISTING agent (model, personality, or display name). ' +
    "BEFORE calling this, run skill_view('tool-update-agent') for the exact format. " +
    'To change the model, call list_models first and pass the exact modelId — a model not ' +
    "valid for the agent's provider is rejected. " +
    'Fails if no agent with that slug exists (use create_agent to make one).',
  inputSchema: UpdateAgentInput,
  riskLevel: 'write',
  execute: async (input, ctx) => {
    if (!input.model && !input.personality && !input.name) {
      return {
        ok: false,
        error: 'Nothing to update — provide at least one of model, personality, or name.',
      };
    }

    const [agent] = await ctx.db
      .select({ id: agents.id, llmKeyId: agents.llmKeyId })
      .from(agents)
      .where(and(eq(agents.entityId, ctx.entityId), eq(agents.slug, input.slug)));

    if (!agent) {
      return {
        ok: false,
        error: `No agent named "${input.slug}" in this workspace. Use create_agent to make a new one, or check the slug.`,
      };
    }

    // Validate the new model against the agent's provider catalog.
    if (input.model) {
      const resolved = await resolveAgentProvider(ctx.db, ctx.entityId, agent.llmKeyId);
      if (resolved) {
        const check = validateModelForProvider(resolved.provider, input.model);
        if (!check.ok) return check;
      }
    }

    const patch: Record<string, unknown> = { updatedAt: new Date() };
    if (input.model) patch['model'] = input.model;
    if (input.personality) patch['personality'] = input.personality;
    if (input.name) patch['name'] = input.name;

    await ctx.db.update(agents).set(patch).where(eq(agents.id, agent.id));

    const changed = [
      input.model ? `model → ${input.model}` : null,
      input.personality ? 'personality' : null,
      input.name ? `name → ${input.name}` : null,
    ]
      .filter(Boolean)
      .join(', ');

    return { ok: true, message: `Updated agent "${input.slug}": ${changed}.` };
  },
};
