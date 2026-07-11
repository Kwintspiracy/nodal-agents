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

// ─── Guard 1f — non-progress detector (per-tool-call streaks) ────────────────
//
// Two live incidents on 2026-07-11 that Guard 1b (identical turn signature)
// and Guard 1d (per-turn same-tool-only streak, above) both missed — in both
// cases the tool INPUTS varied turn to turn and an occasional other tool call
// was mixed in, so neither signature-matching nor per-turn homogeneity ever
// latched:
//   - A worker spent 38 consecutive turns of `run_command` probing for a
//     ComfyUI install (dir/where/findstr…), never progressing, never telling
//     the user — $0.25 and a lot of context burned before manual cancellation.
//   - Watcher agents burned turns retrying `attach_mcp`/`create_mcp` after
//     failures instead of reporting the blocker.
//
// These two signals track the raw SEQUENCE OF TOOL CALLS (not turns, and not
// requiring identical inputs/outputs):
//   S1 — the SAME tool name called this many times in a row (any inputs).
//   S2 — this many tool calls in a row threw or returned the runtime's error
//        outcome (ToolExecutionResult.outcome === 'error').
// Each nudges once per streak, then fails loud if the streak keeps growing
// past the fail threshold. These are intentionally NOT part of `ChainLimits` /
// `DEFAULT_LIMITS` — they are per-call reducers, not per-job caps, and keeping
// them standalone avoids forcing every existing `ChainLimits` literal (see
// chain-counters.test.ts) to grow four more required fields.
//
// Calibration: 12/24 and 5/10 both use a 2x nudge→fail ratio, mirroring Guard
// 1d's nudge-then-fail cadence — enough headroom for a legitimate multi-step
// retry (a few pagination attempts, a couple of transient 429s) before the
// runtime intervenes, and a further doubling so a nudged agent that ignores
// the warning doesn't burn the whole 50-turn budget before the job dies.
// Override via env — see execute.ts.

/** S1 — nudge threshold: 12 consecutive calls to the same tool. */
export const NON_PROGRESS_SAME_TOOL_NUDGE_AT = 12;
/** S1 — fail threshold: 24 consecutive calls to the same tool. */
export const NON_PROGRESS_SAME_TOOL_FAIL_AT = 24;
/** S2 — nudge threshold: 5 consecutive failing tool calls. */
export const NON_PROGRESS_ERROR_STREAK_NUDGE_AT = 5;
/** S2 — fail threshold: 10 consecutive failing tool calls. */
export const NON_PROGRESS_ERROR_STREAK_FAIL_AT = 10;

/**
 * Tools exempt from S1 — they neither extend nor break a same-tool streak:
 *   - `return_result` — a model can legitimately emit it more than once while
 *     finalizing (see the duplicate-return_result handling in execute.ts).
 *   - `telegram_send_message` — a multi-part reply legitimately sends several
 *     messages in a row; the per-job delivery ceiling already bounds this.
 * S2 (error streak) has NO exemption — a failing send is still a real failure.
 */
export const NON_PROGRESS_EXEMPT_TOOLS: ReadonlySet<string> = new Set([
  'return_result',
  'telegram_send_message',
]);

export type NonProgressSignal = 'none' | 'nudge' | 'fail';

/** S1 state — the pure reducer's running same-tool streak. */
export interface SameToolStreakState {
  readonly toolName: string | null;
  readonly streak: number;
  readonly nudged: boolean;
}

export const INITIAL_SAME_TOOL_STREAK_STATE: SameToolStreakState = {
  toolName: null,
  streak: 0,
  nudged: false,
};

/**
 * S1 reducer — call once per tool call, in execution order (a parallel batch
 * within one turn counts in its response order). Returns the next state and
 * whether this call crossed a threshold. `nudge` fires once per streak (not
 * once per call past the threshold); `fail` fires once the streak reaches
 * `failAt` and stays terminal from the caller's perspective (the job dies).
 */
export function recordSameToolCall(
  state: SameToolStreakState,
  toolName: string,
  nudgeAt: number = NON_PROGRESS_SAME_TOOL_NUDGE_AT,
  failAt: number = NON_PROGRESS_SAME_TOOL_FAIL_AT,
): { state: SameToolStreakState; signal: NonProgressSignal } {
  if (NON_PROGRESS_EXEMPT_TOOLS.has(toolName)) {
    return { state, signal: 'none' };
  }
  const continuing = state.toolName === toolName;
  const streak = continuing ? state.streak + 1 : 1;
  const nudged = continuing ? state.nudged : false;
  if (streak >= failAt) {
    return { state: { toolName, streak, nudged }, signal: 'fail' };
  }
  if (streak >= nudgeAt && !nudged) {
    return { state: { toolName, streak, nudged: true }, signal: 'nudge' };
  }
  return { state: { toolName, streak, nudged }, signal: 'none' };
}

/** S2 state — the pure reducer's running consecutive-error count. */
export interface ErrorStreakState {
  readonly streak: number;
  readonly nudged: boolean;
}

export const INITIAL_ERROR_STREAK_STATE: ErrorStreakState = { streak: 0, nudged: false };

/**
 * S2 reducer — call once per tool call with whether that call threw or
 * returned the runtime's error outcome. A success resets the streak to 0
 * (and re-arms the nudge for the next streak). Unlike S1, no tool is exempt.
 */
export function recordToolOutcome(
  state: ErrorStreakState,
  failed: boolean,
  nudgeAt: number = NON_PROGRESS_ERROR_STREAK_NUDGE_AT,
  failAt: number = NON_PROGRESS_ERROR_STREAK_FAIL_AT,
): { state: ErrorStreakState; signal: NonProgressSignal } {
  if (!failed) {
    return { state: INITIAL_ERROR_STREAK_STATE, signal: 'none' };
  }
  const streak = state.streak + 1;
  if (streak >= failAt) {
    return { state: { streak, nudged: state.nudged }, signal: 'fail' };
  }
  if (streak >= nudgeAt && !state.nudged) {
    return { state: { streak, nudged: true }, signal: 'nudge' };
  }
  return { state: { streak, nudged: state.nudged }, signal: 'none' };
}

// ─── Guard 1g — verify-before-assert nudge (cancel/undo intent) ─────────────
//
// Live incident 2026-07-11: a user asked their agent whether it could post
// Discord release announcements. The agent called `create_schedule` — a
// schedule row was created and persisted, active. The user replied "Annule".
// The agent's ENTIRE response turn was `telegram_send_message` +
// `return_result` — it never called a read tool (`list_schedules`) to check
// what actually existed, and asserted "Aucune schedule créée — rien à
// annuler ✅", directly contradicting its OWN prior turn, visible in the same
// thread history. Failure class: unverified assertions about platform state
// / the agent's own past actions.
//
// Guard 1g catches this class at the runtime layer: an inbound cancel/undo
// request answered without a single verification tool call. It is a NUDGE,
// not a hard fail — a "cancel"/"undo" can legitimately be about conversation
// content rather than a platform object, so after one nudge the agent is
// free to answer textually. See job/execute.ts for the wiring (checked ONCE,
// on the job's first turn only) and Layer 1 (thread-history.ts's action
// ledger) + Layer 3 (the `verify-before-done` baseline skill) for the other
// two legs of the fix.

/**
 * FR + EN cancel/undo intent, matched against the first
 * `CANCEL_UNDO_INTENT_SCAN_CHARS` characters of the job's inbound task,
 * case-insensitive. Deliberately broad (annuler/cancel/undo/supprimer/
 * enlever/retirer/désactiver/arrêter) — false positives just cost one
 * advisory nudge, false negatives leave the incident's failure mode open.
 */
export const CANCEL_UNDO_INTENT_RE =
  /\b(annule[rz]?|cancel|undo|supprime[rz]?|enl[eè]ve[rz]?|retire[rz]?|d[ée]sactive[rz]?|arr[êe]te[rz]?)\b/i;

/** Chars of the inbound task scanned for cancel/undo intent (Guard 1g). */
export const CANCEL_UNDO_INTENT_SCAN_CHARS = 200;

/**
 * Guard 1g nudge text — injected once (as a `user`-role message, same
 * mechanism as Guard 1d/1f's forcing messages) when the job's first turn
 * answers a cancel/undo request using only delivery/return tools.
 */
export const VERIFY_BEFORE_ASSERT_NUDGE =
  'Runtime notice: the user asked to cancel/undo something. Verify actual platform state with your READ tools (list_schedules, list_conversations, ...) BEFORE asserting what exists or what was done — your own memory of past actions is not a source of truth. Then act on what you find and report precisely what remains.';

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
