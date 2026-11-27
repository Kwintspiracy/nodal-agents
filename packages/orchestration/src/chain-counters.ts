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
  // Guard 1d — progress reminder. Keys on turns WITHOUT any delivery tool call
  // or return_result (not on identical args, so it reaches agents that vary
  // queries but never deliver — the forensic pattern of jobs 0ff86a1f /
  // ac31d982 / 394b13f4). Calibration against REAL job history:
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
  //   - maxNoDeliveryNudges=2: two reminders per run at most.
  //   - nudgeSpacing=3: minimum turns between nudges to avoid flooding.
  // It never stops the run (#504). Until 0.9.4 a `noDeliveryFailAt=40` hard fail
  // (`no_delivery_runaway`) sat under maxTurns: "a clearer-error, slightly-
  // earlier backstop", as this comment called it. It measured progress by
  // MESSAGES sent, so it also killed long productions (files, builds, renders),
  // and the reminder that preceded it ordered "STOP gathering now", which an
  // agent read as a stop (Motage, job 4781aacc). The stops now belong to the
  // run's own limits, the same for every agent: maxTurns (which delivers what
  // was written), the run budget (#442), the token budget, and the
  // no-progress detector above for identical loops.
  // All four overridable via env — see execute.ts.
  noDeliveryNudgeAt: 12,
  sameToolStreakNudgeAt: 8,
  maxNoDeliveryNudges: 2,
  nudgeSpacing: 3,
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
  // cap would need to be raised for them. Since #442 this is only the default of
  // the workspace setting `entities.max_run_cost_usd` (Settings → Run budget),
  // which the runner reads instead of an environment variable.
  maxCostPerJobUsd: 2.0,
};

/**
 * How many more delegation hops a job at `depth` may take (invariant #8). A
 * job at the maximum depth delegates to nobody, by either route: `assign_*`
 * (execute.ts), `create_task` (planner/task-tools.ts) and the task board that
 * spawns its children (cron/execute-ready.ts) all read this, and the team
 * block announces no reach beyond it (reach.ts, Codex review of #473 pass 2).
 */
export function remainingDelegationHops(
  depth: number,
  limits: ChainLimits = DEFAULT_LIMITS,
): number {
  return Math.max(0, limits.maxDelegationDepth - depth);
}

/** The refusal every delegation route gives at the maximum depth. LLM-channel text. */
export function delegationDepthExceededMessage(limits: ChainLimits = DEFAULT_LIMITS): string {
  return (
    `delegation_depth_exceeded: this job is already at the maximum delegation depth ` +
    `(${limits.maxDelegationDepth}) and cannot delegate further. Do the work yourself with ` +
    `your own tools, or call return_result with status='blocked' explaining what you could ` +
    `not complete.`
  );
}

/**
 * How many more delegations a job that has resumed `chainCount` times may
 * start and still receive the result of (invariant #8). The parent resumes
 * once per delegation (`resumeDelegated` adds one to `chain_count`), and a job
 * whose `chain_count` reached `maxChains` is refused at entry. A delegation
 * that would bring it there is refused at the call instead, before its child
 * runs and is paid for nothing.
 */
export function remainingDelegationResumes(
  chainCount: number,
  limits: ChainLimits = DEFAULT_LIMITS,
): number {
  return Math.max(0, limits.maxChains - 1 - chainCount);
}

/** The refusal of a delegation over the resume cap. LLM-channel text. */
export function delegationResumeLimitMessage(
  chainCount: number,
  limits: ChainLimits = DEFAULT_LIMITS,
): string {
  return (
    `delegation_limit_reached: this job has resumed ${chainCount} times and may resume at most ` +
    `${limits.maxChains - 1} times, so the result of another delegation could not come back ` +
    `to it. Do the remaining work yourself with your own tools, or call return_result with ` +
    `what was done and what was not.`
  );
}

// ─── Guard 1f — non-progress detector (consecutive failing tool calls) ───────
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
// The signal kept here reads a FACT the runner holds: this many tool calls in
// a row threw or returned the runtime's error outcome
// (ToolExecutionResult.outcome === 'error'). It nudges once per streak, then
// fails loud if the streak keeps growing past the fail threshold.
//
// A second signal, S1, used to count the SAME tool NAME called N times in a
// row, any inputs, success included, and killed the job at 24: forty file
// reads, thirty moves or twenty-five calendar events are legitimate work that
// looks exactly like that. It is gone. What still stops a loop that does not
// fail: Guard 1b (12 identical turns: same call, same input, same result), the
// per-turn budget of invariant #8 (`assertTurnToolCallBudget`), `maxTurns`
// (which delivers what was written), the token budget and the run cost budget;
// Guard 1d keeps informing a run that uses one tool turn after turn.
//
// These are intentionally NOT part of `ChainLimits` / `DEFAULT_LIMITS` — they
// are per-call reducers, not per-job caps. Override via env — see execute.ts.

/** S2 — nudge threshold: 5 consecutive failing tool calls. */
export const NON_PROGRESS_ERROR_STREAK_NUDGE_AT = 5;
/** S2 — fail threshold: 10 consecutive failing tool calls. */
export const NON_PROGRESS_ERROR_STREAK_FAIL_AT = 10;

export type NonProgressSignal = 'none' | 'nudge' | 'fail';

/** S2 state — the pure reducer's running consecutive-error count. */
export interface ErrorStreakState {
  readonly streak: number;
  readonly nudged: boolean;
}

export const INITIAL_ERROR_STREAK_STATE: ErrorStreakState = { streak: 0, nudged: false };

/**
 * S2 reducer — call once per tool call with whether that call threw or
 * returned the runtime's error outcome. A success resets the streak to 0
 * (and re-arms the nudge for the next streak). No tool is exempt.
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

/**
 * The per-turn tool-call budget of invariant #8, applied to a turn as a whole
 * (#564). Throws {@link ToolCallLimitExceededError} when the model emitted more
 * calls in one turn than `limits.maxToolCallsPerTurn`. Every place where the
 * runner acts on the tool calls of a model response calls it before acting on
 * any: the job loop (through `ChainCounters.admitTurn`), the reflection and
 * the two curator passes, and the calls of a chat turn (`runTaskOf` in
 * `apps/runner/src/chat/run-chat-turn.ts`, which acts on the first
 * `run_task` only, and still refuses a turn over the budget). The re-read of
 * a chat turn's prose (`apps/runner/src/llm/action-recheck.ts`) runs
 * the same check, but an over-budget re-read is ABANDONED, not the turn: it is
 * only a safety net, and the turn's prose stands (PR #604). Incident
 * 2026-09-28: a 307-call turn was executed call by call up to the 50th.
 *
 * Not the CLI runtimes (Claude Code, Codex): the CLI runs its own tools inside
 * its own process, the runner sees each call only as the stream announces it,
 * and a turn's size is never known in advance. There the same budget is a
 * gate every stream reader passes each opened call through
 * (`ToolCallGate` in `apps/runner/src/cli-runtime/spawn-turn.ts`): the calls
 * under the budget have run, the one over it may have started and is never
 * handed to the caller, and the process tree is killed (see that file for what
 * is and is not guaranteed).
 */
export function assertTurnToolCallBudget(
  toolCallCount: number,
  limits: Pick<ChainLimits, 'maxToolCallsPerTurn'> = DEFAULT_LIMITS,
): void {
  if (toolCallCount > limits.maxToolCallsPerTurn) {
    throw new ToolCallLimitExceededError(toolCallCount, limits.maxToolCallsPerTurn);
  }
}

// ─── ChainCounters ────────────────────────────────────────────────────────────

/**
 * Per-job counter that enforces anti-loop limits.
 *
 * Usage:
 *   const counters = new ChainCounters();
 *   counters.bumpChain();          // call when a new self-chain starts
 *   counters.admitTurn(n);         // call per turn, before any of its n tool calls runs
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
   * Called once per turn, with the number of tool calls the model emitted,
   * BEFORE any of them runs (#564). A turn over the per-turn budget is refused
   * whole: its size is known the moment the response arrives, so running its
   * first N calls would be running a degenerate turn. See
   * {@link assertTurnToolCallBudget}.
   */
  admitTurn(toolCallCount: number): void {
    this._toolCallsThisTurn = toolCallCount;
    assertTurnToolCallBudget(toolCallCount, this.limits);
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
