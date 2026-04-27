// job/chain.ts — self-chaining: POST /api/worker to self when time budget is low
// This is the TypeScript port of trigger_worker() + chain increment from legacy.

import type { RunnerEnv } from '../env.ts';

// ─── MAX_CHAINS ───────────────────────────────────────────────────────────────

/** Matches DEFAULT_LIMITS.maxChains from @nodalai/orchestration */
export const MAX_CHAINS = 5;

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

// ─── selfChain ────────────────────────────────────────────────────────────────

/**
 * Trigger the next worker chain for a job by POSTing to our own /api/worker.
 *
 * This is used when the current chain hits a time budget boundary and needs
 * to continue in a new invocation. The caller must have already saved a
 * checkpoint (saveCheckpoint) and updated chain_count before calling this.
 *
 * Does NOT increment chain_count here — that is the caller's responsibility
 * (so the count is persisted in DB before we fire the next worker).
 */
export async function selfChain(jobId: string, runnerEnv: RunnerEnv): Promise<void> {
  const baseUrl = runnerEnv.APP_URL ?? 'http://localhost:3001';
  const url = `${baseUrl}/api/worker`;

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };

  // Auth: use WORKER_SECRET if set (bearer mode or internal)
  if (runnerEnv.WORKER_SECRET) {
    headers['Authorization'] = `Bearer ${runnerEnv.WORKER_SECRET}`;
  }

  // Fire-and-forget — we don't wait for the response
  // The next worker picks up from the saved checkpoint
  void fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ jobId }),
  }).catch(() => {
    // Log failure but don't crash — the job will be recovered on next cron tick
    // (orphan detection resets stuck jobs after 5 min)
  });
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
