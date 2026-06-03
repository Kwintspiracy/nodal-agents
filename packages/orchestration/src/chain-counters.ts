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
