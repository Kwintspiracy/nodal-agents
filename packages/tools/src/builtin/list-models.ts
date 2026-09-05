// Built-in: list_models
// Returns the valid model ids the agent can assign when creating or editing an
// agent — the curated MODEL_CATALOG for the entity's provider (the same source
// the dashboard model picker uses). Call this BEFORE create_agent / update_agent
// to map a user's words ("DeepSeek v4 pro") to the exact modelId
// ("deepseek/deepseek-v4-pro"). Read-only, always-on.

import { z } from 'zod';
import { entityLlmKeys, eq, and } from '@nodal-agents/db';
import { MODEL_CATALOG } from '@nodal-agents/shared';
import type { ToolDefinition } from '../types';

export const ListModelsInputSchema = z.object({
  provider: z
    .string()
    .optional()
    .describe(
      'Optional provider key (e.g. "openrouter", "deepseek"). Omit to use the entity\'s active provider.',
    ),
});

export type ListModelsInput = z.infer<typeof ListModelsInputSchema>;

type ListModelsOutput =
  | { ok: true; provider: string; models: Array<{ id: string; label: string }> }
  | { ok: false; error: string };

export const listModelsTool: ToolDefinition<typeof ListModelsInputSchema, ListModelsOutput> = {
  name: 'list_models',
  description:
    'List the valid model ids for assigning to an agent (curated catalog for the provider). ' +
    'Call this BEFORE create_agent / update_agent and pass the exact modelId it returns — ' +
    'never guess a model string.',
  inputSchema: ListModelsInputSchema,
  riskLevel: 'read',
  card: 'text',
  execute: async (input, ctx) => {
    let provider = input.provider;
    if (!provider) {
      const [active] = await ctx.db
        .select({ provider: entityLlmKeys.provider })
        .from(entityLlmKeys)
        .where(and(eq(entityLlmKeys.entityId, ctx.entityId), eq(entityLlmKeys.isActive, true)));
      provider = active?.provider;
    }
    if (!provider) {
      return { ok: false, error: 'No active LLM provider is configured for this workspace.' };
    }
    const catalog = MODEL_CATALOG[provider] ?? [];
    return {
      ok: true,
      provider,
      models: catalog.map((e) => ({ id: e.modelId, label: e.label })),
    };
  },
};
