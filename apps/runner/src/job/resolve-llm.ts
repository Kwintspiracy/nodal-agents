// resolve-llm.ts — per-agent LLM client resolution with provider failover.
//
// Single source of truth shared by executeJob (the work loop) and runChatTurn
// (the in-app chat) so the failover chain can't drift between them.
//
// Builds the agent's ordered key chain — primary (llmKeyId) first, then the
// configured fallbacks — and returns a NodalLlmClient. With fallbacks it wraps
// the chain in the failover client (Guard 2): on a transient/availability
// failure the runner fails over to the next key; all-down throws
// AllProvidersFailedError at call time. With a single key it returns a plain
// client (behaviour identical to pre-Guard-2).

import { inArray, entityLlmKeys, type AnyDrizzleDb } from '@nodal-agents/db';
import { createLlmClient, createFailoverLlmClient } from '@nodal-agents/llm';
import type { ProviderConfig, NodalLlmClient } from '@nodal-agents/llm';
import { MODEL_CATALOG, findModelCatalogEntry } from '@nodal-agents/shared';
import { decrypt } from '@nodal-agents/secrets';

export type ResolveLlmResult =
  | {
      ok: true;
      client: NodalLlmClient;
      primaryProvider: string;
      chainLength: number;
      /**
       * Whether the primary's model accepts a forced `tool_choice: 'required'`,
       * read from the model catalog by (provider, agent.model). Unknown/custom
       * models ⇒ `true` (the runtime tool_choice floor backstops a wrong guess).
       */
      primarySupportsForcedToolChoice: boolean;
    }
  | { ok: false; reason: 'agent_no_llm_configured' }
  | { ok: false; reason: 'llm_key_invalid'; detail: string };

/**
 * Resolve an agent's LLM client (primary + optional failover fallbacks).
 *
 * @param onSkip called for each fallback key that is skipped (missing/inactive
 *   or has no usable model) — never silent, but never fatal either.
 */
export async function resolveAgentLlmClient(
  db: AnyDrizzleDb,
  agent: {
    llmKeyId: string | null;
    /**
     * Ordered failover chain AFTER the primary — each link is a (keyId, model)
     * pair so a fallback runs on a CHOSEN model. An empty `model` ⇒ that
     * provider's catalog default.
     */
    fallbackChain: readonly { keyId: string; model: string }[] | null;
    model: string;
  },
  onSkip?: (info: { keyId: string; reason: string }) => void,
): Promise<ResolveLlmResult> {
  if (!agent.llmKeyId) return { ok: false, reason: 'agent_no_llm_configured' };

  // Unified, deduped, ordered chain: the primary first (on the agent's own
  // model), then each fallback (on its chosen model). Order = failover priority.
  const seen = new Set<string>();
  const requested: Array<{ keyId: string; model: string }> = [];
  for (const link of [
    { keyId: agent.llmKeyId, model: agent.model },
    ...(agent.fallbackChain ?? []),
  ]) {
    if (typeof link.keyId === 'string' && link.keyId.length > 0 && !seen.has(link.keyId)) {
      seen.add(link.keyId);
      requested.push({ keyId: link.keyId, model: link.model ?? '' });
    }
  }

  const ids = requested.map((r) => r.keyId);
  const rows = await db.select().from(entityLlmKeys).where(inArray(entityLlmKeys.id, ids));
  const byId = new Map(rows.map((r) => [r.id, r]));

  try {
    const configs: ProviderConfig[] = [];
    for (const { keyId, model: requestedModel } of requested) {
      const row = byId.get(keyId);
      if (!row || !row.isActive) {
        // A skipped key (missing or toggled inactive) never aborts resolution —
        // the chain simply moves to the next active key. So disabling the
        // PRIMARY key fails over to the first active fallback rather than
        // leaving the agent unrunnable.
        onSkip?.({ keyId, reason: 'missing_or_inactive' });
        continue;
      }
      // Use the requested model if set, else fall back to the provider's first
      // curated catalog model (the agent's primary model id is provider-specific
      // and a fallback may have left its model empty).
      const model =
        requestedModel.length > 0
          ? requestedModel
          : (MODEL_CATALOG[row.provider]?.[0]?.modelId ?? '');
      if (!model) {
        onSkip?.({ keyId, reason: 'no_catalog_model' });
        continue;
      }
      // Decrypt at-rest ciphertext. Throws on tamper / wrong master key →
      // surfaced as llm_key_invalid below (invariant 4).
      const plaintextKey = row.apiKey ? decrypt(row.apiKey) : '';
      configs.push({
        provider: row.provider as ProviderConfig['provider'],
        model,
        apiKey: plaintextKey || undefined,
        baseURL: row.baseUrl ?? undefined,
      });
    }

    // No active key anywhere in the chain (primary disabled AND no usable
    // fallback) ⇒ the agent genuinely has no LLM to run on.
    if (configs.length === 0) return { ok: false, reason: 'agent_no_llm_configured' };

    // configs[0] is the EFFECTIVE primary — the agent's primary if active, else
    // the first active fallback it failed over to.
    const effectivePrimary = configs[0]!;
    const client =
      configs.length > 1 ? createFailoverLlmClient(configs) : createLlmClient(effectivePrimary);
    return {
      ok: true,
      client,
      primaryProvider: effectivePrimary.provider,
      chainLength: configs.length,
      // Capability comes from the model CATALOG (provider, model of the
      // effective primary), not a stored column. Unknown/custom models default
      // to true; the runtime tool_choice floor backstops a wrong guess.
      primarySupportsForcedToolChoice:
        findModelCatalogEntry(effectivePrimary.provider, effectivePrimary.model)?.capabilities
          .forcedToolChoice ?? true,
    };
  } catch (err) {
    return {
      ok: false,
      reason: 'llm_key_invalid',
      detail: err instanceof Error ? err.message.slice(0, 200) : 'llm_key_invalid',
    };
  }
}
