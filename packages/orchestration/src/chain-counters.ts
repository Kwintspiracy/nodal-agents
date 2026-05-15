// chain-counters.ts — per-job execution limit enforcement
// Invariant 8: max 5 chains, max 50 tool calls/turn, max 3 delegation depth, max 50 turns.
// Approval semantics: chain_count does NOT bump when resuming from awaiting_approval.

import {
  ChainLimitExceededError,
  ToolCallLimitExceededError,
  DelegationDepthExceededError,
} from './errors';
import type { ChainLimits } from './types';

// ─── DEFAULT_LIMITS ───────────────────────────────────────────────────────────
// Hard-coded per invariant 8. Override only in tests via constructor argument.

export const DEFAULT_LIMITS: ChainLimits = {
  maxChains: 5,
  maxToolCallsPerTurn: 50,
  maxDelegationDepth: 3,
  maxTurns: 50, // matches Hermes Agent's per-subagent iteration budget; cumulative cap across resumes
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
