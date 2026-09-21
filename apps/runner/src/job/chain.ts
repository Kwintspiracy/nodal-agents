// job/chain.ts — chain-count budget guard (max chained worker resumes per job)

import { DEFAULT_LIMITS } from '@nodal-agents/orchestration';

// ─── MAX_CHAINS ───────────────────────────────────────────────────────────────

/**
 * LA MÊME valeur que `DEFAULT_LIMITS.maxChains`, parce que c'est ELLE, et non
 * une copie qui lui ressemble.
 *
 * Elle était recopiée ici, sous un commentaire qui PROMETTAIT qu'elle
 * correspondait. Depuis #377, l'écran des réglages affiche
 * `DEFAULT_LIMITS.maxChains` comme « reprises par run » : une divergence
 * ferait mentir l'écran sur la garde que le runner oppose réellement, et
 * personne ne le verrait (Reviewer C, PR #392).
 */
export const MAX_CHAINS = DEFAULT_LIMITS.maxChains;

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
