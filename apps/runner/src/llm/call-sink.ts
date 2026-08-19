// llm/call-sink.ts — the llm_calls sink (étape D of the subscription-runtimes
// plan; Lot A of the 2026-08-19 reproducibility audit).
//
// Bridges packages/llm's observation seam (LlmCallObserver — DB-free) to the
// llm_calls table. One sink instance per caller context (job loop, chat,
// curators, reflection, cron); the observation itself carries the per-link
// facts (provider, effective model, usage, cost, failover index), the sink
// adds WHO was calling (source/entity/agent/job/turn) and the derived fields
// (cost estimate fallback, tools hash).
//
// Fire-and-forget by design: a trace write failure is LOGGED, never thrown,
// and never delays inference.

import { createHash } from 'node:crypto';
import { llmCalls, type AnyDrizzleDb } from '@nodal-agents/db';
import type { LlmCallObservation, LlmCallObserver } from '@nodal-agents/llm';
import { estimateModelCostUsd } from '@nodal-agents/shared';

export interface LlmCallSinkContext {
  /** Where the call came from: 'job' | 'chat' | 'curator' | 'reflection' | 'cron'. */
  source: string;
  entityId?: string | null;
  agentId?: string | null;
  /** Resolved lazily — the job loop knows its jobId at sink-build time, but chat may not. */
  getJobId?: () => string | null;
  /** Resolved lazily — the loop's turn counter advances while the client lives. */
  getTurn?: () => number | null;
}

/** sha256 of the sorted tool-name list — cheap drift detection across calls. */
export function hashToolNames(names: readonly string[] | null): string | null {
  if (!names || names.length === 0) return null;
  return createHash('sha256')
    .update([...names].sort().join('\n'))
    .digest('hex');
}

/**
 * Build the observer to inject into resolveAgentLlmClient / createLlmClient.
 * Synchronous signature (the observation seam never awaits) — the insert runs
 * fire-and-forget with a logged failure.
 */
export function makeLlmCallSink(db: AnyDrizzleDb, ctx: LlmCallSinkContext): LlmCallObserver {
  return (obs: LlmCallObservation): void => {
    try {
      const inputTokens = obs.usage?.inputTokens ?? null;
      const outputTokens = obs.usage?.outputTokens ?? null;
      // Provider-reported cost wins (OpenRouter accounting); otherwise estimate
      // from the catalog when we at least have token counts. Null when neither
      // exists (e.g. terminal error before a response) — never guessed.
      let costUsd = obs.costUsd;
      if (costUsd === null && inputTokens !== null && outputTokens !== null) {
        const est = estimateModelCostUsd(
          obs.provider,
          obs.modelConfigured,
          inputTokens,
          outputTokens,
        );
        // estimateModelCostUsd returns 0 for models the catalog doesn't price —
        // that means UNKNOWN, not free: keep null rather than a misleading 0.
        costUsd = est > 0 ? est : null;
      }

      void db
        .insert(llmCalls)
        .values({
          entityId: ctx.entityId ?? null,
          agentId: ctx.agentId ?? null,
          jobId: ctx.getJobId?.() ?? null,
          source: ctx.source,
          turn: ctx.getTurn?.() ?? null,
          modelRequested: obs.meta.modelRequested ?? null,
          // The effective model: what the provider REPORTS having served when
          // available, else the model this chain link was configured with.
          // Never re-derived from a catalog after the fact (the old fallback
          // hole this table exists to close).
          modelEffective: obs.modelReported ?? obs.modelConfigured,
          provider: obs.provider,
          llmKeyId: obs.meta.keyId ?? null,
          reasoningEffort: obs.reasoningEffort,
          toolChoice: obs.toolChoice,
          toolNames: obs.toolNames ?? null,
          toolsHash: hashToolNames(obs.toolNames),
          inputTokens,
          outputTokens,
          cachedTokens: obs.usage?.cachedTokens ?? null,
          costUsd,
          durationMs: obs.durationMs,
          failover: (obs.meta.chainIndex ?? 0) > 0,
          error: obs.error,
        })
        .catch((err: unknown) => {
          console.warn(`[llm-sink] llm_calls insert failed (source=${ctx.source}):`, err);
        });
    } catch (err) {
      console.warn(`[llm-sink] observation handling failed (source=${ctx.source}):`, err);
    }
  };
}
