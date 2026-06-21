// meta-ops/agent-model.ts — shared helpers for create_agent / update_agent.
//
// Grounds the `model` field so an orchestrator can't silently set a model that
// doesn't exist for the entity's provider (invariant #4: no silent bad data).
// The valid set is the curated MODEL_CATALOG for the provider — the same source
// the dashboard model picker uses, so agent-created and human-created agents
// agree on what "valid" means.

import { eq, and, entityLlmKeys } from '@nodal-agents/db';
import type { AnyDrizzleDb } from '@nodal-agents/db';
import { MODEL_CATALOG } from '@nodal-agents/shared';

/**
 * Resolve the provider an agent's model will run against:
 *   - the agent's own llmKeyId, if set;
 *   - else the entity's active LLM key.
 * Returns null when the entity has no usable key (caller skips validation).
 */
export async function resolveAgentProvider(
  db: AnyDrizzleDb,
  entityId: string,
  llmKeyId?: string | null,
): Promise<{ provider: string; keyId: string } | null> {
  if (llmKeyId) {
    const [k] = await db
      .select({ provider: entityLlmKeys.provider, id: entityLlmKeys.id })
      .from(entityLlmKeys)
      .where(eq(entityLlmKeys.id, llmKeyId));
    if (k) return { provider: k.provider, keyId: k.id };
  }
  const [active] = await db
    .select({ provider: entityLlmKeys.provider, id: entityLlmKeys.id })
    .from(entityLlmKeys)
    .where(and(eq(entityLlmKeys.entityId, entityId), eq(entityLlmKeys.isActive, true)));
  return active ? { provider: active.provider, keyId: active.id } : null;
}

/**
 * Validate a model id against the curated catalog for a provider. When the
 * provider has no catalogue (custom/unknown provider) validation is skipped —
 * we never block a legitimate custom setup, only catch obviously-wrong ids for
 * providers we DO curate (the common case: a hallucinated id like
 * "deepseek-chat" on an OpenRouter key).
 */
export function validateModelForProvider(
  provider: string,
  model: string,
): { ok: true } | { ok: false; error: string } {
  const catalog = MODEL_CATALOG[provider];
  if (!catalog || catalog.length === 0) return { ok: true }; // uncurated provider — don't block
  if (catalog.some((e) => e.modelId === model)) return { ok: true };

  const list = catalog.map((e) => `${e.modelId} (${e.label})`).join('; ');
  return {
    ok: false,
    error:
      `Model "${model}" is not a valid model for the "${provider}" provider. ` +
      `Call list_models to see the choices, then pass the exact modelId. ` +
      `Valid models: ${list}.`,
  };
}
