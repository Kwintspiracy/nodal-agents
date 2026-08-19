// @nodal-agents/llm — call observation seam (étape D of the
// subscription-runtimes plan; Lot A of the 2026-08-19 reproducibility audit).
//
// One observation per generateText/generateObject invocation on a client —
// i.e. one per FAILOVER LINK ATTEMPT, which is exactly the granularity the
// inference trace needs (a turn served by the 2nd link produces two rows:
// the failed primary and the successful fallback).
//
// packages/llm knows NOTHING about the database: the observer is an opaque
// callback injected by the caller (the runner wires it to the llm_calls
// table). Emitting never throws and never delays the call — a broken
// observer must not break inference.

/**
 * Caller-supplied identity of one chain link, echoed verbatim into every
 * observation from that client. `modelRequested` is what the agent/link ASKED
 * for before resolution (empty fallback model ⇒ null) — the counterpart to
 * the RESOLVED model the client was built with.
 */
export interface LlmClientMeta {
  keyId?: string | null;
  modelRequested?: string | null;
  /** Position in the failover chain (0 = primary). */
  chainIndex?: number;
}

export interface LlmCallObservation {
  kind: 'generateText' | 'generateObject';
  provider: string;
  /** The model this client was CONFIGURED with — the resolved chain link. */
  modelConfigured: string;
  /**
   * The model the provider REPORTS having served (response.modelId), when
   * present. The ground truth for re-routing providers (OpenRouter).
   */
  modelReported: string | null;
  reasoningEffort: string | null;
  toolChoice: string | null;
  /** Names of the tools OFFERED on this call (null = no tools). */
  toolNames: string[] | null;
  usage: {
    /** AI SDK semantics: input CACHE INCLUS (reads AND writes for Anthropic). */
    inputTokens: number | null;
    outputTokens: number | null;
    /** Cache READS (usage.cachedInputTokens). */
    cachedTokens: number | null;
    /**
     * Cache WRITES (providerMetadata.anthropic.cacheCreationInputTokens,
     * billed 1.25× input) — needed to derive effective (non-cached) input.
     * null = provider does not report it — never a guessed 0.
     */
    cacheCreationTokens: number | null;
  } | null;
  /** Provider-reported USD cost when available (OpenRouter usage accounting). */
  costUsd: number | null;
  durationMs: number;
  /** Terminal error message after all retries, null on success. */
  error: string | null;
  meta: LlmClientMeta;
}

export type LlmCallObserver = (obs: LlmCallObservation) => void;

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/**
 * Assemble an observation from a raw AI SDK result (or an error). Pure and
 * defensive: every field degrades to null rather than throwing — the trace
 * must survive SDK shape drift, never break the call.
 */
export function buildLlmCallObservation(args: {
  kind: LlmCallObservation['kind'];
  provider: string;
  modelConfigured: string;
  reasoningEffort: string | null | undefined;
  callArgs: unknown;
  result: unknown | null;
  error: unknown | null;
  durationMs: number;
  meta: LlmClientMeta;
}): LlmCallObservation {
  const call = (args.callArgs ?? {}) as { tools?: Record<string, unknown>; toolChoice?: unknown };
  const toolNames = call.tools && typeof call.tools === 'object' ? Object.keys(call.tools) : null;
  const toolChoice =
    call.toolChoice == null
      ? null
      : typeof call.toolChoice === 'string'
        ? call.toolChoice
        : JSON.stringify(call.toolChoice).slice(0, 200);

  const r = (args.result ?? {}) as {
    usage?: {
      inputTokens?: unknown;
      outputTokens?: unknown;
      cachedInputTokens?: unknown;
    };
    providerMetadata?: {
      openrouter?: { usage?: { cost?: unknown } };
      anthropic?: { cacheCreationInputTokens?: unknown };
    };
    response?: { modelId?: unknown };
  };
  const usageRaw = args.result != null ? r.usage : undefined;
  const usage = usageRaw
    ? {
        inputTokens: num(usageRaw.inputTokens),
        outputTokens: num(usageRaw.outputTokens),
        cachedTokens: num(usageRaw.cachedInputTokens),
        // Cache writes live in provider metadata (verified on the installed
        // @ai-sdk/anthropic 3.0.76) — null for providers that don't report it.
        cacheCreationTokens: num(r.providerMetadata?.anthropic?.cacheCreationInputTokens),
      }
    : null;

  return {
    kind: args.kind,
    provider: args.provider,
    modelConfigured: args.modelConfigured,
    modelReported:
      typeof r.response?.modelId === 'string' && r.response.modelId !== ''
        ? r.response.modelId
        : null,
    reasoningEffort: args.reasoningEffort ?? null,
    toolChoice,
    toolNames,
    usage,
    costUsd: num(r.providerMetadata?.openrouter?.usage?.cost),
    durationMs: args.durationMs,
    error:
      args.error == null
        ? null
        : args.error instanceof Error
          ? `${args.error.name}: ${args.error.message}`.slice(0, 500)
          : String(args.error).slice(0, 500),
    meta: args.meta,
  };
}

/** Deliver an observation to an observer — never throws, never awaits. */
export function emitLlmCall(observer: LlmCallObserver | undefined, obs: LlmCallObservation): void {
  if (!observer) return;
  try {
    observer(obs);
  } catch (err) {
    console.warn('[llm-observe] observer threw (ignored):', err);
  }
}
