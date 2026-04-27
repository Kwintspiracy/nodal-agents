// job/state.ts — JobState machine: transitions and typed state values
// All transitions are explicit. Invalid transitions throw JobStateError.

import { eq } from '@nodalai/db';
import { agentJobs } from '@nodalai/db';
import type { AnyDrizzleDb } from '@nodalai/db';

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

/**
 * Mark a job as completed. Sets result, completedAt, and clears error.
 */
export async function completeJob(
  db: AnyDrizzleDb,
  jobId: string,
  result: string,
  toolsUsed: string[] = [],
): Promise<void> {
  await db
    .update(agentJobs)
    .set({
      status: 'completed',
      result,
      toolsUsed,
      completedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(agentJobs.id, jobId));
}

/**
 * Mark a job as failed. Stores the error code/message.
 */
export async function failJob(db: AnyDrizzleDb, jobId: string, errorCode: string): Promise<void> {
  await db
    .update(agentJobs)
    .set({
      status: 'failed',
      error: errorCode,
      updatedAt: new Date(),
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
    })
    .where(eq(agentJobs.id, jobId));
}
