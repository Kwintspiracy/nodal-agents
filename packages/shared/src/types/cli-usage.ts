// CliModelUsage — per-model usage breakdown of ONE coding-CLI run.
//
// Why this exists (question Quentin 20/08 « ce cache qui coûte tant ») : a
// single CLI run can be served by SEVERAL models (the main model plus any
// sub-agent the CLI spawns on a cheaper tier), and the claude CLI reports the
// split — per model: tokens AND its own notional cost. Nodal only stored the
// AGGREGATE (cli_runs.input_tokens/output_tokens/…), so a run's cost could
// not be reconciled against per-token prices: reconstructing 2,05 $ from the
// aggregate at one model's rates landed ~15 % off, with no way to tell whether
// the gap was a sub-agent on another tier or a bad assumption.
//
// Stored in cli_runs.model_usage (migration 0079). NULL when the provider
// reports no breakdown (codex today) — never a synthesized single entry, which
// would invent a model attribution the CLI never made (invariant #4).

export type CliModelUsage = {
  /** Model id EXACTLY as the CLI reported it — never normalized or mapped. */
  model: string;
  /** Input tokens for this model, cache excluded (the CLI's own semantics). */
  inputTokens: number;
  outputTokens: number;
  /** Cache READS (0.1× the input price). */
  cachedTokens: number;
  /** Cache WRITES (1.25× the input price). null = absent from the payload. */
  cacheCreationTokens: number | null;
  /** Notional USD cost the CLI attributes to THIS model. null = not reported. */
  costUsd: number | null;
};
