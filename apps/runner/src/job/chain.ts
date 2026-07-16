// job/chain.ts — chain-count budget guard (max chained worker resumes per job)

// ─── MAX_CHAINS ───────────────────────────────────────────────────────────────

/** Matches DEFAULT_LIMITS.maxChains from @nodal-agents/orchestration */
export const MAX_CHAINS = 15;

// ─── ChainLimitError ──────────────────────────────────────────────────────────

export class ChainLimitError extends Error {
  readonly code = 'chain_limit_exceeded' as const;

  constructor(
    public readonly current: number,
    public readonly limit: number,
  ) {
    super(`chain_limit_exceeded: ${current} >= ${limit}`);
    this.name = 'ChainLimitError';
  }
}

// ─── checkChainLimit ─────────────────────────────────────────────────────────

/**
 * Throw ChainLimitError if chainCount >= MAX_CHAINS.
 * Call this before incrementing — if current count is at the limit, we fail loud.
 */
export function checkChainLimit(chainCount: number): void {
  if (chainCount >= MAX_CHAINS) {
    throw new ChainLimitError(chainCount, MAX_CHAINS);
  }
}
