// chain-counters.ts — per-job execution limit enforcement
// Invariant 8: max N chains, max 50 tool calls/turn, max 3 delegation depth,
// max 50 turns, max 3 consecutive user-facing delivery-only turns (anti-spam).
// Approval semantics: chain_count does NOT bump when resuming from awaiting_approval.

import {
  ChainLimitExceededError,
  ToolCallLimitExceededError,
  DelegationDepthExceededError,
} from './errors';
import type { ChainLimits } from './types';

// ─── DEFAULT_LIMITS ───────────────────────────────────────────────────────────
// Hard-coded defaults. Override only in tests via constructor argument.
//
// maxChains was initially calibrated to 5 in commit `7103b3a` (runaway-fix)
// without empirical data — the assumption was that >5 self-chains signalled a
// runaway orchestrator. Live data from 2026-05-19 (job `cbc0e2a4`) proved the
// cap too aggressive once sequential-delegation discipline shipped: a
// legitimate "fill 5 vault pages" workflow used 5 chains for 5 successful
// child completions and was killed by the cap BEFORE the parent could
// telegram + return_result.
//
// We can safely raise it because two other guards have shipped since:
//   - `failed_delegations_count` cap (commit `b76d449`, default 1) blocks the
//     actual runaway pattern: re-delegating the same task after a failure.
//   - `maxDelegationDepth: 3` blocks parent→child→grand-child→… recursion.
// `chain_count` is therefore now just "how many resumes this job has run" —
// a budget that should accommodate the longest legitimate workflow plus a
// couple of fallback / finalisation turns.
//
// Calibration to 15: typical "fill N pages" workflow burns N chains; allow
// up to ~10 user-driven sub-tasks plus ~3 chains for fallback (Conciergus
// retrying via a different specialist) and ~2 chains for wrap-up turns
// (telegram + return_result). Worst-case wall-clock 15 × ~3 min = ~45 min
// stays under any reasonable user-patience ceiling for batch work.
// maxConsecutiveDeliveryTurns = 3: a well-behaved agent sends its reply in ONE
// turn (the telegram_send_message tool description tells it to batch multiple
// messages into a single response) and then calls return_result. So a single
// delivery-only turn is the norm; 3 leaves slack for a chatty local model that
// splits a long reply across a couple of turns. Beyond that it's monologuing —
// live incident: job 9bbdbfd7 (2026-05-29) emitted 11 filler/emoji messages on
// 11 consecutive delivery-only turns before finally calling return_result.
export const DEFAULT_LIMITS: ChainLimits = {
  maxChains: 15,
  maxToolCallsPerTurn: 50,
  maxDelegationDepth: 3,
  maxTurns: 50, // matches Hermes Agent's per-subagent iteration budget; cumulative cap across resumes
  maxConsecutiveDeliveryTurns: 3,
  // 1.5M total tokens: a loud backstop well above any legitimate single job
  // (typical jobs sit in the tens of thousands) yet below the ~2.4M-token
  // runaway that motivated it. Override per-deployment via MAX_TOTAL_TOKENS_PER_JOB.
  maxTotalTokensPerJob: 1_500_000,
  // 12 identical (toolName+input+output) turns in a row before declaring the job
  // stuck. Deliberately conservative: a real poll completes (output changes) long
  // before 12 identical reads, so this only catches genuinely degenerate loops —
  // and maxTurns (50) is the ultimate backstop above it.
  maxNoProgressRepeats: 12,
  // Guard 1d — no-delivery runaway detector. Keys on turns WITHOUT any delivery
  // tool call or return_result (not on identical args, so it catches runaways
  // where the agent varies queries but never delivers — the forensic pattern of
  // jobs 0ff86a1f / ac31d982 / 394b13f4). Calibration against REAL job history:
  //   - Median legit job ≈ 4 turns; 92% of legit jobs are ≤8 turns.
  //   - The legit TAIL is long: most jobs deliver only on their FINAL turn, so a
  //     legit COMPLETED job can reach a max non-delivery run of 47 turns. Runaways
  //     don't separate from this on turns-without-delivery alone — they just burn
  //     to the 50-turn cap. So turns-without-delivery is a NUDGE signal, NOT a
  //     clean fail signal; the true cost-cap is the (future) dollar budget.
  //   - noDeliveryNudgeAt=12: only ~8% of legit jobs exceed 12 non-delivery turns,
  //     so the first nudge is well-targeted — it lands on long jobs that very
  //     likely already have enough, without firing on the 92% short majority.
  //   - sameToolStreakNudgeAt=8: 8 consecutive turns using the SAME single tool
  //     with no delivery is a textbook scope-creep/empty-resource loop (jobs
  //     0ff86a1f, 394b13f4). Fires sooner than noDeliveryNudgeAt for those cases.
  //   - maxNoDeliveryNudges=2: two forced prompts before the hard fail.
  //   - nudgeSpacing=3: minimum turns between nudges to avoid flooding.
  //   - noDeliveryFailAt=40: hard fail after 40 turns without delivery (post-nudge
  //     budget exhausted). The second-highest legit max non-delivery run is 38, so
  //     40 spares all legit-ish completions and sits just below maxTurns=50. The
  //     only job it catches early is c66f1db0 (run 47) — the known
  //     MCP-empty-structuredContent 2.4M-token bug-burn. The nudge above is the
  //     PRIMARY mechanism; this is just a clearer-error, slightly-earlier backstop
  //     below the turn cap.
  // All five overridable via env — see execute.ts.
  noDeliveryNudgeAt: 12,
  sameToolStreakNudgeAt: 8,
  maxNoDeliveryNudges: 2,
  nudgeSpacing: 3,
  noDeliveryFailAt: 40,
  // Guard 1e — real dollar cost cap per job.
  //
  // 2.0 is a deliberate starting point, not a calibrated ceiling: we now have
  // the tooling to observe real $/job and will tighten it once data accumulates.
  // Known data points from OpenRouter/DeepSeek jobs:
  //   - Runaway burns (token-limit kills): $0.7–1.6
  //   - Legit cheap-model jobs: ~$0.3
  //   - Mid-range models (Gemini Flash, Llama 3.3): likely ~$0.5–1.0 per job
  //
  // This default spares all current legit jobs AND catches the known runaways.
  // Per-agent cost caps (for expensive models like Claude Opus, GPT-4o) are a
  // future follow-up — those cost more per job legitimately, so a global $2
  // cap would need to be raised for them. Override via MAX_COST_PER_JOB_USD.
  maxCostPerJobUsd: 2.0,
};

// ─── ChainCounters ────────────────────────────────────────────────────────────

/**
 * Per-job counter that enforces anti-loop limits.
 *
 * Usage:
 *   const counters = new ChainCounters();
 *   counters.bumpChain();          // call when a new self-chain starts
 *   counters.bumpToolCall();       // call per tool_use in a turn
 *   counters.bumpDelegationDepth() // call when descending into a child job
 *
 * Approval semantics:
 *   When a job resumes from awaiting_approval, bumpChain() must NOT be called.
 *   The caller (runner/approve handler) is responsible for NOT calling bumpChain
 *   on approval-resume. This class encodes that as `bumpChainOnApprovalResume()`
 *   which is a no-op — providing a named hook so the runner's intent is explicit.
 */
export class ChainCounters {
  private _chains = 0;
  private _toolCallsThisTurn = 0;
  private _delegationDepth = 0;

  constructor(public readonly limits: ChainLimits = DEFAULT_LIMITS) {}

  // ─── Getters ────────────────────────────────────────────────────────────────

  get chains(): number {
    return this._chains;
  }

  get toolCallsThisTurn(): number {
    return this._toolCallsThisTurn;
  }

  get delegationDepth(): number {
    return this._delegationDepth;
  }

  // ─── Bump methods ────────────────────────────────────────────────────────────

  /**
   * Called when a new self-chain starts (worker timed out, resumes on next chain).
   * Throws ChainLimitExceededError if max chains reached.
   *
   * NOT called on approval-resume (use bumpChainOnApprovalResume() for that — no-op).
   */
  bumpChain(): void {
    this._chains += 1;
    if (this._chains >= this.limits.maxChains) {
      throw new ChainLimitExceededError(this._chains, this.limits.maxChains);
    }
  }

  /**
   * No-op. Called when a job resumes from awaiting_approval.
   * Approval pauses do NOT count as a chain — chain_count stays the same.
   * This method exists to make the caller's intent explicit in the codebase.
   */
  bumpChainOnApprovalResume(): void {
    // intentional no-op — chain_count does not increment across awaiting_approval
  }

  /**
   * Called once per tool_use in a turn.
   * Throws ToolCallLimitExceededError if max tool calls/turn reached.
   */
  bumpToolCall(): void {
    this._toolCallsThisTurn += 1;
    if (this._toolCallsThisTurn > this.limits.maxToolCallsPerTurn) {
      throw new ToolCallLimitExceededError(
        this._toolCallsThisTurn,
        this.limits.maxToolCallsPerTurn,
      );
    }
  }

  /**
   * Reset per-turn tool call counter (call at the start of each new turn).
   */
  resetTurnToolCalls(): void {
    this._toolCallsThisTurn = 0;
  }

  /**
   * Called when a new child job is created (delegation depth increases).
   * Throws DelegationDepthExceededError if max depth reached.
   */
  bumpDelegationDepth(): void {
    this._delegationDepth += 1;
    if (this._delegationDepth > this.limits.maxDelegationDepth) {
      throw new DelegationDepthExceededError(this._delegationDepth, this.limits.maxDelegationDepth);
    }
  }

  /**
   * Serialize for persistence (checkpoint).
   */
  toJSON(): { chains: number; toolCallsThisTurn: number; delegationDepth: number } {
    return {
      chains: this._chains,
      toolCallsThisTurn: this._toolCallsThisTurn,
      delegationDepth: this._delegationDepth,
    };
  }

  /**
   * Restore from a persisted snapshot.
   */
  static fromJSON(
    data: { chains?: number; toolCallsThisTurn?: number; delegationDepth?: number },
    limits?: ChainLimits,
  ): ChainCounters {
    const counters = new ChainCounters(limits);
    counters._chains = data.chains ?? 0;
    counters._toolCallsThisTurn = data.toolCallsThisTurn ?? 0;
    counters._delegationDepth = data.delegationDepth ?? 0;
    return counters;
  }
}
