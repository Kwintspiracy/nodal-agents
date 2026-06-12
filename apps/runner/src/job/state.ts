// job/state.ts — JobState machine: transitions and typed state values
// All transitions are explicit. Invalid transitions throw JobStateError.

import { eq } from '@nodal-agents/db';
import { agentJobs } from '@nodal-agents/db';
import type { AnyDrizzleDb } from '@nodal-agents/db';

// ─── JobState ─────────────────────────────────────────────────────────────────

export type JobStatus =
  | 'pending'
  | 'processing'
  | 'completed'
  | 'failed'
  | 'awaiting_approval'
  | 'awaiting_delegation'
  | 'cancelled';

// ─── JobStateError ────────────────────────────────────────────────────────────

export class JobStateError extends Error {
  readonly code = 'invalid_job_transition' as const;

  constructor(
    public readonly jobId: string,
    public readonly from: string,
    public readonly to: JobStatus,
  ) {
    super(`invalid_job_transition: ${jobId} cannot go from '${from}' to '${to}'`);
    this.name = 'JobStateError';
  }
}

// ─── Valid transitions ────────────────────────────────────────────────────────

/**
 * Allowed transitions for the job state machine.
 * Only listed transitions are valid. Any other is rejected by assertTransition().
 */
const VALID_TRANSITIONS: ReadonlyMap<JobStatus, ReadonlySet<JobStatus>> = new Map([
  ['pending', new Set<JobStatus>(['processing', 'cancelled'])],
  [
    'processing',
    new Set<JobStatus>([
      'completed',
      'failed',
      'awaiting_approval',
      'awaiting_delegation',
      'pending', // self-chain reset (saves checkpoint then retriggers)
    ]),
  ],
  ['awaiting_approval', new Set<JobStatus>(['pending', 'failed', 'cancelled'])],
  ['awaiting_delegation', new Set<JobStatus>(['pending', 'failed', 'cancelled'])],
  ['completed', new Set<JobStatus>([])],
  ['failed', new Set<JobStatus>([])],
  ['cancelled', new Set<JobStatus>([])],
]);

// ─── assertTransition ─────────────────────────────────────────────────────────

/**
 * Throw JobStateError if `from → to` is not a valid transition.
 */
export function assertTransition(jobId: string, from: JobStatus, to: JobStatus): void {
  const allowed = VALID_TRANSITIONS.get(from);
  if (!allowed?.has(to)) {
    throw new JobStateError(jobId, from, to);
  }
}

// ─── DB state helpers ─────────────────────────────────────────────────────────

/**
 * Update a job's status in DB. Does NOT validate transition — caller must call
 * assertTransition() first. Used by execute.ts where we've already validated.
 */
export async function setJobStatus(
  db: AnyDrizzleDb,
  jobId: string,
  status: JobStatus,
  extra: Record<string, unknown> = {},
): Promise<void> {
  await db
    .update(agentJobs)
    .set({ status, updatedAt: new Date(), ...extra })
    .where(eq(agentJobs.id, jobId));
}

/**
 * Mark a job as processing. Stores workerId and workerStartedAt.
 * Returns false if the job is not in a runnable state (concurrent claim check).
 */
export async function claimJob(
  db: AnyDrizzleDb,
  jobId: string,
  _workerId: string,
): Promise<boolean> {
  const rows = await db
    .update(agentJobs)
    .set({
      status: 'processing',
      updatedAt: new Date(),
    })
    .where(eq(agentJobs.id, jobId))
    .returning({ id: agentJobs.id, status: agentJobs.status });

  // If no row was updated (concurrent claim), return false
  return rows.length > 0 && rows[0]?.id === jobId;
}

interface RunStats {
  inputTokens: number;
  outputTokens: number;
  /** Cumulative effective (non-cached) input — what Guard 1a's budget measures. */
  effectiveInputTokens?: number;
  /** Cumulative real dollar cost billed by the provider (Guard 1e). Undefined when the provider doesn't report cost. */
  totalCostUsd?: number;
  /** The upstream provider that last served an LLM call for this job (from providerMetadata.openrouter.provider). Null when not reported. */
  servedProvider?: string | null;
  turn: number;
  totalDurationMs?: number;
}

/**
 * Mark a job as completed. Sets result, completedAt, and clears error.
 * Persists per-turn accumulated token counts and final turn when provided.
 *
 * The `messages` parameter persists the full conversation transcript so the
 * dashboard /jobs/[id] panel can show the assistant's tool-call turns. Without
 * it, single-turn jobs that complete via return_result leave the messages
 * JSONB at its initial `[user]`-only state — the assistant's response never
 * lands in DB even though it ran in memory.
 *
 * Brique 33: when `result` is empty, we do NOT overwrite the existing
 * agent_jobs.result column. This preserves any value written earlier by
 * dashboard_publish (or any other delivery tool side-effect). Only a non-empty
 * result (e.g. from the no-tool-calls text branch) replaces the stored value.
 */
export async function completeJob(
  db: AnyDrizzleDb,
  jobId: string,
  result: string,
  toolsUsed: string[] = [],
  stats?: RunStats,
  messages?: unknown[],
): Promise<void> {
  await db
    .update(agentJobs)
    .set({
      status: 'completed',
      // Brique 33: preserve existing result (e.g. set by dashboard_publish
      // earlier in this job) when no new text is provided.
      ...(result.length > 0 ? { result } : {}),
      toolsUsed,
      // Clear stale error from any prior failed attempt — the docstring already
      // promised this; without it, a resumed/retried job ends up `completed` with
      // a leftover error column, which is confusing in the dashboard.
      error: null,
      completedAt: new Date(),
      updatedAt: new Date(),
      ...(messages !== undefined && { messages }),
      ...(stats && {
        inputTokens: stats.inputTokens,
        outputTokens: stats.outputTokens,
        turn: stats.turn,
        ...(stats.effectiveInputTokens !== undefined && {
          effectiveInputTokens: stats.effectiveInputTokens,
        }),
        ...(stats.totalCostUsd !== undefined && { totalCostUsd: stats.totalCostUsd }),
        ...(stats.servedProvider !== undefined && { servedProvider: stats.servedProvider }),
        ...(stats.totalDurationMs !== undefined && { totalDurationMs: stats.totalDurationMs }),
      }),
    })
    .where(eq(agentJobs.id, jobId));
}

/**
 * Mark a job as failed. Stores the error code/message.
 * Persists tokens + turn + duration when provided so partial run state isn't lost.
 *
 * Sets `completedAt` so the row matches the terminal-state semantics of
 * completed jobs: dashboards / filters / cron `resetOrphanedJobs` all use
 * `completed_at IS NULL` to mean "still in flight". Without this set on
 * failure, failed jobs leaked into "in-flight" queries and never appeared in
 * "recent" / "delivered" listings.
 */
export async function failJob(
  db: AnyDrizzleDb,
  jobId: string,
  errorCode: string,
  stats?: RunStats,
  messages?: unknown[],
): Promise<void> {
  const now = new Date();
  await db
    .update(agentJobs)
    .set({
      status: 'failed',
      error: errorCode,
      completedAt: now,
      updatedAt: now,
      // Persist the transcript on failure (mirrors completeJob) so a failed job
      // is DIAGNOSABLE, not opaque. The resume/guard failure paths used to lose
      // it entirely. Omitted ⇒ the stored messages are left untouched.
      ...(messages ? { messages } : {}),
      ...(stats && {
        inputTokens: stats.inputTokens,
        outputTokens: stats.outputTokens,
        turn: stats.turn,
        ...(stats.effectiveInputTokens !== undefined && {
          effectiveInputTokens: stats.effectiveInputTokens,
        }),
        ...(stats.totalCostUsd !== undefined && { totalCostUsd: stats.totalCostUsd }),
        ...(stats.servedProvider !== undefined && { servedProvider: stats.servedProvider }),
        ...(stats.totalDurationMs !== undefined && { totalDurationMs: stats.totalDurationMs }),
      }),
    })
    .where(eq(agentJobs.id, jobId));
}

/**
 * Finalize a job that the user cancelled mid-flight.
 *
 * The status column is ALREADY 'cancelled' at this point — the dashboard
 * action `cancelJobAction` flipped it as soon as the user clicked. This
 * helper just persists the partial transcript + accumulated stats and
 * stamps `completed_at` so orphan-cleanup / "in-flight" filters treat
 * the row as terminal.
 *
 * Deliberately does NOT touch `status` again: the runner might be racing
 * against a SECOND status transition (e.g. user re-cancelling a
 * cancelled job is a no-op) and we never want to clobber a status
 * intentionally set by another writer.
 */
export async function cancelJob(
  db: AnyDrizzleDb,
  jobId: string,
  stats?: RunStats,
  messages?: unknown[],
): Promise<void> {
  const now = new Date();
  await db
    .update(agentJobs)
    .set({
      completedAt: now,
      updatedAt: now,
      ...(messages !== undefined && { messages }),
      ...(stats && {
        inputTokens: stats.inputTokens,
        outputTokens: stats.outputTokens,
        turn: stats.turn,
        ...(stats.effectiveInputTokens !== undefined && {
          effectiveInputTokens: stats.effectiveInputTokens,
        }),
        ...(stats.totalCostUsd !== undefined && { totalCostUsd: stats.totalCostUsd }),
        ...(stats.servedProvider !== undefined && { servedProvider: stats.servedProvider }),
        ...(stats.totalDurationMs !== undefined && { totalDurationMs: stats.totalDurationMs }),
      }),
    })
    .where(eq(agentJobs.id, jobId));
}

/**
 * Save job checkpoint (messages + turn + chain_count) for self-chaining.
 * Does NOT change status — caller does that separately.
 */
export async function saveCheckpoint(
  db: AnyDrizzleDb,
  jobId: string,
  checkpoint: {
    messages: unknown[];
    turn: number;
    chainCount: number;
    toolsUsed: string[];
    inputTokens?: number;
    outputTokens?: number;
    effectiveInputTokens?: number;
    totalCostUsd?: number;
    servedProvider?: string | null;
    totalDurationMs?: number;
  },
): Promise<void> {
  await db
    .update(agentJobs)
    .set({
      messages: checkpoint.messages,
      turn: checkpoint.turn,
      chainCount: checkpoint.chainCount,
      toolsUsed: checkpoint.toolsUsed,
      updatedAt: new Date(),
      ...(checkpoint.inputTokens !== undefined && { inputTokens: checkpoint.inputTokens }),
      ...(checkpoint.outputTokens !== undefined && { outputTokens: checkpoint.outputTokens }),
      ...(checkpoint.effectiveInputTokens !== undefined && {
        effectiveInputTokens: checkpoint.effectiveInputTokens,
      }),
      ...(checkpoint.totalCostUsd !== undefined && { totalCostUsd: checkpoint.totalCostUsd }),
      ...(checkpoint.servedProvider !== undefined && { servedProvider: checkpoint.servedProvider }),
      ...(checkpoint.totalDurationMs !== undefined && {
        totalDurationMs: checkpoint.totalDurationMs,
      }),
    })
    .where(eq(agentJobs.id, jobId));
}

/**
 * Heartbeat: bump `updated_at` so the orphan-cleanup cron (resetOrphanedJobs,
 * staleMinutes=5) does not reap a job that is actively working but slow — e.g. a
 * turn running many blocking tool calls, or a long LLM call near the timeout.
 * Cheap single-column UPDATE; safe to call repeatedly mid-turn. Mirrors the bump
 * that reset-orphans itself does for legitimately-waiting delegation parents.
 */
export async function touchJob(db: AnyDrizzleDb, jobId: string): Promise<void> {
  await db.update(agentJobs).set({ updatedAt: new Date() }).where(eq(agentJobs.id, jobId));
}
