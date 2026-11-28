// cron/tests/reset-orphans.test.ts
// Acceptance criteria:
//   - 6-min-stale in_progress task with no job_id → reset to todo
//   - fresh in_progress task (1 min ago) → NOT reset
//   - in_progress task with no lock time → reset (defensive)
//   - in_progress task whose job is completed → reset
//   - already todo task → unchanged

import { describe, it, expect, beforeAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import { eq } from '@nodal-agents/db';
import { agentJobs, agentTasks, approvalRequests } from '@nodal-agents/db';
import {
  resetOrphanedTasks,
  resetOrphanedJobs,
  findPendingJobsToRecover,
  failStalePendingJobs,
  expireStaleApprovals,
} from '../reset-orphans.ts';
import { reclaimJobsOfDeadRunners } from '../reclaim-jobs.ts';
import { JOB_LIVENESS, createPresence } from '../../job/liveness.ts';

let db: TestDb;
let seed: Awaited<ReturnType<typeof seedMinimal>>;

beforeAll(async () => {
  const result = await spinUpTestDb();
  db = result.db;
  seed = await seedMinimal(db);
});

async function createTask(overrides: {
  status: string;
  lockedAt?: Date | null;
  lockedBy?: string | null;
  jobId?: string | null;
  rootJobId?: string | null;
}) {
  const rows = await db
    .insert(agentTasks)
    .values({
      entityId: seed.entityId,
      orchestratorId: seed.agentId,
      assignedAgentId: seed.agentId,
      title: 'Test task',
      status: overrides.status,
      lockedAt: overrides.lockedAt ?? null,
      lockedBy: overrides.lockedBy ?? null,
      jobId: overrides.jobId ?? null,
      rootJobId: overrides.rootJobId ?? null,
    })
    .returning();
  return rows[0]!;
}

describe('resetOrphanedTasks', () => {
  it('resets a 6-min-stale in_progress task with no job_id to todo', async () => {
    const staleDate = new Date(Date.now() - 6 * 60 * 1000);
    const task = await createTask({
      status: 'in_progress',
      lockedAt: staleDate,
      lockedBy: 'worker-abc',
      jobId: null,
    });

    const count = await resetOrphanedTasks(db, 5);
    expect(count).toBeGreaterThanOrEqual(1);

    const updated = await db
      .select({ status: agentTasks.status, lockedBy: agentTasks.lockedBy })
      .from(agentTasks)
      .where(eq(agentTasks.id, task.id));

    expect(updated[0]?.status).toBe('todo');
    expect(updated[0]?.lockedBy).toBeNull();
  });

  it('does NOT reset a fresh (1-min-old) in_progress task', async () => {
    const freshDate = new Date(Date.now() - 60 * 1000); // 1 min ago
    const task = await createTask({
      status: 'in_progress',
      lockedAt: freshDate,
      lockedBy: 'worker-fresh',
      jobId: null,
    });

    // Only reset tasks older than 5 minutes
    await resetOrphanedTasks(db, 5);
    // This task is fresh — should NOT be reset
    const updated = await db
      .select({ status: agentTasks.status })
      .from(agentTasks)
      .where(eq(agentTasks.id, task.id));

    expect(updated[0]?.status).toBe('in_progress');
  });

  it('resets an in_progress task with NULL lockedAt', async () => {
    const task = await createTask({
      status: 'in_progress',
      lockedAt: null, // no lock time — defensive reset
      lockedBy: null,
      jobId: null,
    });

    await resetOrphanedTasks(db, 5);

    const updated = await db
      .select({ status: agentTasks.status })
      .from(agentTasks)
      .where(eq(agentTasks.id, task.id));

    expect(updated[0]?.status).toBe('todo');
  });

  it('FINALIZES (not re-runs) an in_progress task whose linked job completed', async () => {
    // A completed job carrying a result.
    const completedJobRows = await db
      .insert(agentJobs)
      .values({
        entityId: seed.entityId,
        agentId: seed.agentId,
        channel: 'task-board',
        task: 'parent task',
        status: 'completed',
        result: 'the agent did the work',
      })
      .returning();
    const completedJob = completedJobRows[0]!;

    const staleDate = new Date(Date.now() - 10 * 60 * 1000);
    const task = await createTask({
      status: 'in_progress',
      lockedAt: staleDate,
      lockedBy: 'worker-old',
      jobId: completedJob.id,
    });

    await resetOrphanedTasks(db, 5);

    const updated = await db
      .select({ status: agentTasks.status, result: agentTasks.result })
      .from(agentTasks)
      .where(eq(agentTasks.id, task.id));

    // Case B mirrors the job outcome onto the task — done, with the job's result.
    // It must NEVER reset to 'todo' (that would re-run already-completed work,
    // the live duplication bug where the same agent posted to the Cortex 3x).
    expect(updated[0]?.status).toBe('done');
    expect(updated[0]?.status).not.toBe('todo');
    expect(updated[0]?.result).toBe('the agent did the work');
  });

  it('blocks (not re-runs) an in_progress task whose linked job failed', async () => {
    const failedJobRows = await db
      .insert(agentJobs)
      .values({
        entityId: seed.entityId,
        agentId: seed.agentId,
        channel: 'task-board',
        task: 'parent task',
        status: 'failed',
        result: 'Énergie à 4 — insuffisant pour poster',
        error: 'agent_blocked',
      })
      .returning();
    const failedJob = failedJobRows[0]!;

    const task = await createTask({
      status: 'in_progress',
      lockedAt: new Date(Date.now() - 10 * 60 * 1000),
      lockedBy: 'worker-old',
      jobId: failedJob.id,
    });

    await resetOrphanedTasks(db, 5);

    const [updated] = await db
      .select({ status: agentTasks.status, result: agentTasks.result })
      .from(agentTasks)
      .where(eq(agentTasks.id, task.id));

    expect(updated?.status).toBe('blocked');
    expect(updated?.status).not.toBe('todo');
    expect(updated?.result).toBe('Énergie à 4 — insuffisant pour poster');
  });

  it('does not touch todo tasks', async () => {
    const task = await createTask({ status: 'todo', lockedAt: null });

    await resetOrphanedTasks(db, 5);

    const updated = await db
      .select({ status: agentTasks.status })
      .from(agentTasks)
      .where(eq(agentTasks.id, task.id));

    expect(updated[0]?.status).toBe('todo');
  });

  it('returns count of reset tasks', async () => {
    const staleDate = new Date(Date.now() - 10 * 60 * 1000);

    await createTask({ status: 'in_progress', lockedAt: staleDate, jobId: null });
    await createTask({ status: 'in_progress', lockedAt: staleDate, jobId: null });

    const count = await resetOrphanedTasks(db, 5);
    expect(count).toBeGreaterThanOrEqual(2);
  });
});

// ─── resetOrphanedJobs ────────────────────────────────────────────────────────

async function createJob(overrides: {
  status: string;
  updatedAt?: Date;
  createdAt?: Date;
  claimGeneration?: number;
  pendingDelegation?: Record<string, unknown>;
  result?: string;
}) {
  const [row] = await db
    .insert(agentJobs)
    .values({
      entityId: seed.entityId,
      agentId: seed.agentId,
      channel: 'api',
      task: 'orphan candidate',
      status: overrides.status,
      // updatedAt defaults to now() — we override with a raw update post-insert
      // because Drizzle's defaultNow() is computed in JS for postgres-js but
      // pglite + DEFAULT now() in DDL means a value passed as updatedAt is
      // honored. We pass it directly.
      updatedAt: overrides.updatedAt ?? new Date(),
      ...(overrides.createdAt ? { createdAt: overrides.createdAt } : {}),
      ...(overrides.claimGeneration !== undefined
        ? { claimGeneration: overrides.claimGeneration }
        : {}),
      ...(overrides.pendingDelegation ? { pendingDelegation: overrides.pendingDelegation } : {}),
      ...(overrides.result !== undefined ? { result: overrides.result } : {}),
    })
    .returning();
  if (!row) throw new Error('Failed to seed job');
  return row;
}

/**
 * The observing instance, with a monotonic clock the test moves (#1204): a
 * row is judged on how long THIS process has seen it unchanged, never on the
 * age of a date.
 */
function observer() {
  const mono = { t: 0 };
  const presence = createPresence({
    instanceId: randomUUID(),
    holds: () => false,
    monotonicNow: () => mono.t,
  });
  return {
    presence,
    /** Two sweeps, one `stuckRowMs` apart: the second one decides. */
    twice: async <T>(sweep: (p: typeof presence) => Promise<T>): Promise<T> => {
      await sweep(presence);
      mono.t += JOB_LIVENESS.stuckRowMs;
      return sweep(presence);
    },
  };
}

const TEN_MIN_AGO = () => new Date(Date.now() - 10 * 60 * 1000);

describe('resetOrphanedJobs @cap:organiser-equipe/moteur', () => {
  it('marks an awaiting_delegation job that records no delegation as failed with orphan_job_reset', async () => {
    const job = await createJob({ status: 'awaiting_delegation', updatedAt: TEN_MIN_AGO() });

    const o = observer();
    const count = await o.twice((presence) => resetOrphanedJobs(db, { presence }));
    expect(count).toBeGreaterThanOrEqual(1);

    const [row] = await db
      .select({
        status: agentJobs.status,
        error: agentJobs.error,
        result: agentJobs.result,
        completedAt: agentJobs.completedAt,
        observed: agentJobs.sweeperObserved,
      })
      .from(agentJobs)
      .where(eq(agentJobs.id, job.id));

    expect(row?.status).toBe('failed');
    expect(row?.error).toBe('orphan_job_reset');
    // D1: the reaper fills a user-facing result — never a silent failure.
    expect((row?.result ?? '').length).toBeGreaterThan(0);
    // What the reaper read, never a cause it does not know (#1086).
    expect(row?.result).toMatch(
      /^\[stopped: status awaiting_delegation, not updated for 10m0\ds\]$/,
    );
    expect(row?.result).not.toMatch(/restart|redémarr/i);
    // F1 regression — Leg 4: the reap stamps completedAt.
    expect(row?.completedAt).not.toBeNull();
    // #1204: what the sweeper saw is written on the row.
    expect(row?.observed).toMatchObject({ outcome: 'failed', reason: 'no_delegation_recorded' });
  });

  it('seen once, nothing is decided: the normal wake-up may be on its way', async () => {
    const job = await createJob({ status: 'awaiting_delegation', updatedAt: TEN_MIN_AGO() });
    await resetOrphanedJobs(db, { presence: observer().presence });
    const [row] = await db
      .select({ status: agentJobs.status })
      .from(agentJobs)
      .where(eq(agentJobs.id, job.id));
    expect(row?.status).toBe('awaiting_delegation');
  });

  it('does NOT touch a processing job, however old: reclaimJobsOfDeadRunners judges it on its holder', async () => {
    const job = await createJob({
      status: 'processing',
      updatedAt: new Date(Date.now() - 60 * 60 * 1000),
    });

    await observer().twice((presence) => resetOrphanedJobs(db, { presence }));

    const [row] = await db
      .select({ status: agentJobs.status })
      .from(agentJobs)
      .where(eq(agentJobs.id, job.id));
    expect(row?.status).toBe('processing');
  });

  it('does NOT touch jobs in terminal states (completed/failed/cancelled)', async () => {
    const staleDate = TEN_MIN_AGO();
    const completed = await createJob({ status: 'completed', updatedAt: staleDate });
    const failed = await createJob({ status: 'failed', updatedAt: staleDate });
    const cancelled = await createJob({ status: 'cancelled', updatedAt: staleDate });

    await observer().twice((presence) => resetOrphanedJobs(db, { presence }));

    for (const j of [completed, failed, cancelled]) {
      const [row] = await db
        .select({ status: agentJobs.status })
        .from(agentJobs)
        .where(eq(agentJobs.id, j.id));
      expect(row?.status).toBe(j.status);
    }
  });

  it('does NOT touch an awaiting_approval job with no answered request (humans may resolve it later)', async () => {
    const staleDate = new Date(Date.now() - 60 * 60 * 1000); // 1 hour
    const job = await createJob({ status: 'awaiting_approval', updatedAt: staleDate });

    await observer().twice((presence) => resetOrphanedJobs(db, { presence }));

    const [row] = await db
      .select({ status: agentJobs.status })
      .from(agentJobs)
      .where(eq(agentJobs.id, job.id));
    // awaiting_approval is gated on a human acting; its TTL is enforced
    // separately via approval_requests.expires_at — this cron must not
    // pre-empt that.
    expect(row?.status).toBe('awaiting_approval');
  });

  // Regression for live bug observed on job 58e38faa (2026-05-13):
  // a parent in awaiting_delegation whose Summarizer sub-job took 7.5 min
  // for a deep research got nuked by the cron at the 5-min mark, killing
  // the resume path. A parent whose sub-job is alive is never touched.
  it('does NOT reset awaiting_delegation parent when its sub-job is still running', async () => {
    const subJob = await createJob({ status: 'processing', updatedAt: new Date() });
    const parent = await createJob({
      status: 'awaiting_delegation',
      updatedAt: TEN_MIN_AGO(),
      pendingDelegation: {
        toolUseId: 'tu_test',
        toolName: 'assign_summarizer',
        subJobId: subJob.id,
      },
    });

    await observer().twice((presence) => resetOrphanedJobs(db, { presence }));

    const [parentAfter] = await db
      .select({ status: agentJobs.status })
      .from(agentJobs)
      .where(eq(agentJobs.id, parent.id));
    expect(parentAfter?.status).toBe('awaiting_delegation');
  });

  it('DOES NOT touch pending jobs (those are recovered, not failed — see findPendingJobsToRecover)', async () => {
    const job = await createJob({ status: 'pending', updatedAt: TEN_MIN_AGO() });

    await observer().twice((presence) => resetOrphanedJobs(db, { presence }));

    const [after] = await db
      .select({ status: agentJobs.status, error: agentJobs.error })
      .from(agentJobs)
      .where(eq(agentJobs.id, job.id));
    expect(after?.status).toBe('pending');
    expect(after?.error).toBeNull();
  });

  // B31-16: the sub-job completed but the resume path never fired (a crash
  // after the child completed, a caught throw). The parent used to be failed
  // "the service restarted", the child's result left unused. It is now given
  // that result, as by the normal end of a delegation.
  it('gives the parent the result of a sub-job that already completed, instead of failing it', async () => {
    const subJob = await createJob({
      status: 'completed',
      updatedAt: TEN_MIN_AGO(),
      result: 'summary of the sub-job',
    });
    const parent = await createJob({
      status: 'awaiting_delegation',
      updatedAt: TEN_MIN_AGO(),
      pendingDelegation: {
        toolUseId: 'tu_test_orphan',
        toolName: 'assign_summarizer',
        subJobId: subJob.id,
      },
    });
    await db.update(agentJobs).set({ parentJobId: parent.id }).where(eq(agentJobs.id, subJob.id));

    await observer().twice((presence) => resetOrphanedJobs(db, { presence }));

    const [parentAfter] = await db
      .select({ status: agentJobs.status, error: agentJobs.error, messages: agentJobs.messages })
      .from(agentJobs)
      .where(eq(agentJobs.id, parent.id));
    expect(parentAfter?.status).toBe('pending');
    expect(parentAfter?.error).toBeNull();
    expect(JSON.stringify(parentAfter?.messages)).toContain('summary of the sub-job');
  });

  it('a sub-job that was cancelled cancels its waiting parent, as the normal path does', async () => {
    const subJob = await createJob({ status: 'cancelled', updatedAt: TEN_MIN_AGO() });
    const parent = await createJob({
      status: 'awaiting_delegation',
      updatedAt: TEN_MIN_AGO(),
      pendingDelegation: { toolUseId: 'tu_c', toolName: 'assign_summarizer', subJobId: subJob.id },
    });
    await db.update(agentJobs).set({ parentJobId: parent.id }).where(eq(agentJobs.id, subJob.id));

    await observer().twice((presence) => resetOrphanedJobs(db, { presence }));

    const [parentAfter] = await db
      .select({ status: agentJobs.status, error: agentJobs.error })
      .from(agentJobs)
      .where(eq(agentJobs.id, parent.id));
    expect(parentAfter).toEqual({ status: 'cancelled', error: null });
  });
});

describe('reclaimJobsOfDeadRunners and the task board @cap:organiser-equipe/moteur', () => {
  it('does NOT take a processing planner parent that still has outstanding tasks', async () => {
    // A planner orchestrator that fanned out tasks stays `processing` and no
    // run holds it while it waits. An outstanding task means it is waiting —
    // reaping it would seal the fan-in dead.
    const parent = await createJob({ status: 'processing', updatedAt: TEN_MIN_AGO() });
    await createTask({ status: 'in_progress', rootJobId: parent.id });

    await observer().twice((presence) => reclaimJobsOfDeadRunners(db, { presence }));

    const [after] = await db
      .select({ status: agentJobs.status, error: agentJobs.error })
      .from(agentJobs)
      .where(eq(agentJobs.id, parent.id));
    expect(after?.status).toBe('processing');
    expect(after?.error).toBeNull();
  });

  it('does NOT take it either once all its tasks ended: the board’s fan-in ends it (#1204)', async () => {
    const parent = await createJob({ status: 'processing', updatedAt: TEN_MIN_AGO() });
    // All tasks terminal, waiting to be compiled by deliverCompletedRoots —
    // failing (or replaying) the root here would throw that work away.
    await createTask({ status: 'done', rootJobId: parent.id });

    await observer().twice((presence) => reclaimJobsOfDeadRunners(db, { presence }));

    const [after] = await db
      .select({ status: agentJobs.status, error: agentJobs.error })
      .from(agentJobs)
      .where(eq(agentJobs.id, parent.id));
    expect(after).toEqual({ status: 'processing', error: null });
  });
});

describe('findPendingJobsToRecover @cap:parler-a-un-agent/moteur', () => {
  // Regression — 2026-05-26: the Telegram poller fires `triggerWorker`
  // fire-and-forget over HTTP and swallows fetch failures (.catch(()=>{})).
  // On Windows a zombie sibling on port 3001 (Ctrl+C didn't tree-kill)
  // can intercept the request, leaving the job pending forever. The
  // recovery query must surface those rows so the next cron tick drives
  // them through executeJob directly (no HTTP roundtrip).
  it('returns a pending job seen unchanged for stuckRowMs (its wake-up was lost)', async () => {
    const job = await createJob({ status: 'pending', updatedAt: new Date(Date.now() - 60 * 1000) });

    const ids = await observer().twice((presence) => findPendingJobsToRecover(db, { presence }));
    expect(ids).toContain(job.id);
  });

  it('does NOT return a pending job on its first sighting (a trigger may be in flight)', async () => {
    // Triggering AGAIN would race with claimJob and waste an LLM call.
    const job = await createJob({ status: 'pending', updatedAt: new Date() });

    const ids = await findPendingJobsToRecover(db, { presence: observer().presence });
    expect(ids).not.toContain(job.id);
  });

  it('does NOT return rows in any non-pending status', async () => {
    const staleDate = TEN_MIN_AGO();
    const processing = await createJob({ status: 'processing', updatedAt: staleDate });
    const completed = await createJob({ status: 'completed', updatedAt: staleDate });
    const failed = await createJob({ status: 'failed', updatedAt: staleDate });
    const cancelled = await createJob({ status: 'cancelled', updatedAt: staleDate });
    const awaiting = await createJob({ status: 'awaiting_delegation', updatedAt: staleDate });

    const ids = await observer().twice((presence) => findPendingJobsToRecover(db, { presence }));
    for (const id of [processing.id, completed.id, failed.id, cancelled.id, awaiting.id]) {
      expect(ids).not.toContain(id);
    }
  });

  it('starts a job the system put back in the queue, however old its request (#1204)', async () => {
    // A job resumed after a restart, or a parent given its child's result:
    // a continuation, never an abandoned request.
    const job = await createJob({
      status: 'pending',
      claimGeneration: 3,
      createdAt: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
      updatedAt: new Date(Date.now() - 60 * 60 * 1000),
    });

    const ids = await observer().twice((presence) => findPendingJobsToRecover(db, { presence }));
    expect(ids).toContain(job.id);
  });

  it('does NOT recover a request no runner ever claimed that is older than pendingAbandonMs', async () => {
    // Regression — 2026-05-26: a pending job created 4 days earlier
    // (job 03cd4304) got silently resurrected when the recovery had no
    // upper age bound. The user had moved on; waking it up created
    // ghost work they didn't ask for. It is left to failStalePendingJobs.
    const fourDaysAgo = new Date(Date.now() - 4 * 24 * 60 * 60 * 1000);
    const job = await createJob({
      status: 'pending',
      createdAt: fourDaysAgo,
      updatedAt: fourDaysAgo,
    });

    const ids = await observer().twice((presence) => findPendingJobsToRecover(db, { presence }));
    expect(ids).not.toContain(job.id);
  });
});

describe('failStalePendingJobs @cap:parler-a-un-agent/moteur', () => {
  // Regression — 2026-05-26: an unbounded recovery (no upper age) tried
  // to wake a 4-day-old pending job (03cd4304). Requests no runner ever
  // claimed, older than the setting, get a terminal status instead of being
  // silently resurrected — preserves the "user-moved-on" invariant.
  it('marks a never-claimed request older than pendingAbandonMs as failed with stale_pending_abandoned', async () => {
    const job = await createJob({ status: 'pending', createdAt: TEN_MIN_AGO() });

    const n = await failStalePendingJobs(db, { presence: observer().presence });
    expect(n).toBeGreaterThanOrEqual(1);

    const [after] = await db
      .select({
        status: agentJobs.status,
        error: agentJobs.error,
        completedAt: agentJobs.completedAt,
      })
      .from(agentJobs)
      .where(eq(agentJobs.id, job.id));
    expect(after?.status).toBe('failed');
    expect(after?.error).toBe('stale_pending_abandoned');
    // completedAt must be set so the orphan-cleanup / "in-flight"
    // filters treat the row as terminal (matches failJob semantics).
    expect(after?.completedAt).not.toBeNull();
  });

  it('does NOT touch fresh pending jobs', async () => {
    const fresh = await createJob({ status: 'pending', updatedAt: new Date() });
    await failStalePendingJobs(db, { presence: observer().presence });
    const [after] = await db
      .select({ status: agentJobs.status })
      .from(agentJobs)
      .where(eq(agentJobs.id, fresh.id));
    expect(after?.status).toBe('pending');
  });

  it('does NOT abandon a job that was claimed once and put back in the queue (#1204)', async () => {
    const requeued = await createJob({
      status: 'pending',
      claimGeneration: 1,
      createdAt: new Date(Date.now() - 60 * 60 * 1000),
      updatedAt: new Date(Date.now() - 60 * 60 * 1000),
    });
    await failStalePendingJobs(db, { presence: observer().presence });
    const [after] = await db
      .select({ status: agentJobs.status })
      .from(agentJobs)
      .where(eq(agentJobs.id, requeued.id));
    expect(after?.status).toBe('pending');
  });

  it('does NOT touch jobs in non-pending statuses', async () => {
    const staleDate = TEN_MIN_AGO();
    const processing = await createJob({ status: 'processing', createdAt: staleDate });
    const completed = await createJob({ status: 'completed', createdAt: staleDate });
    const cancelled = await createJob({ status: 'cancelled', createdAt: staleDate });

    await failStalePendingJobs(db, { presence: observer().presence });

    for (const j of [processing, completed, cancelled]) {
      const [after] = await db
        .select({ status: agentJobs.status, error: agentJobs.error })
        .from(agentJobs)
        .where(eq(agentJobs.id, j.id));
      expect(after?.status).toBe(j.status);
      expect(after?.error).toBeNull();
    }
  });
});

describe('expireStaleApprovals (D3, issue #349) @cap:approuver-une-action/moteur', () => {
  async function insertApproval(jobId: string, over: { expiresAt: Date; status?: string }) {
    const [row] = await db
      .insert(approvalRequests)
      .values({
        entityId: seed.entityId,
        jobId,
        agentId: seed.agentId,
        toolName: 'run_command',
        toolInput: { command: 'ls' },
        status: over.status ?? 'pending',
        resolvedBy: over.status && over.status !== 'pending' ? 'api' : null,
        expiresAt: over.expiresAt,
      })
      .returning({ id: approvalRequests.id });
    if (!row) throw new Error('Failed to seed approval request');
    return row;
  }

  async function approvalRow(id: string) {
    const [row] = await db
      .select({
        status: approvalRequests.status,
        resolvedAt: approvalRequests.resolvedAt,
        resolvedBy: approvalRequests.resolvedBy,
      })
      .from(approvalRequests)
      .where(eq(approvalRequests.id, id));
    return row;
  }

  async function jobStatus(id: string) {
    const [row] = await db
      .select({ status: agentJobs.status })
      .from(agentJobs)
      .where(eq(agentJobs.id, id));
    return row?.status;
  }

  it('closes a past-deadline pending request and puts its job back to work', async () => {
    const job = await createJob({ status: 'awaiting_approval' });
    const appr = await insertApproval(job.id, { expiresAt: new Date(Date.now() - 60 * 1000) });

    const expired = await expireStaleApprovals(db);
    expect(expired).toBeGreaterThanOrEqual(1);

    const row = await approvalRow(appr.id);
    expect(row?.status).toBe('expired');
    expect(row?.resolvedBy).toBe('system:ttl_expired');
    expect(row?.resolvedAt).toBeInstanceOf(Date);

    // Resumed, not failed: the job goes back to `pending` so the worker replays
    // it and the model reads the expiry on its gated tool call.
    expect(await jobStatus(job.id)).toBe('pending');
  });

  it('a second sweep changes nothing: the row is no longer pending', async () => {
    const job = await createJob({ status: 'awaiting_approval' });
    const appr = await insertApproval(job.id, { expiresAt: new Date(Date.now() - 60 * 1000) });

    await expireStaleApprovals(db);
    const first = await approvalRow(appr.id);
    await expireStaleApprovals(db);
    const second = await approvalRow(appr.id);

    expect(second?.status).toBe('expired');
    expect(second?.resolvedAt?.getTime()).toBe(first?.resolvedAt?.getTime());
  });

  it('does NOT touch a pending request whose deadline is still in the future', async () => {
    const job = await createJob({ status: 'awaiting_approval' });
    const appr = await insertApproval(job.id, {
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    });

    await expireStaleApprovals(db);

    const row = await approvalRow(appr.id);
    expect(row?.status).toBe('pending');
    expect(row?.resolvedAt).toBeNull();
    expect(await jobStatus(job.id)).toBe('awaiting_approval');
  });

  it('does NOT rewrite a request a human already decided, deadline or not', async () => {
    const job = await createJob({ status: 'processing' });
    const appr = await insertApproval(job.id, {
      expiresAt: new Date(Date.now() - 60 * 1000),
      status: 'approved',
    });

    await expireStaleApprovals(db);

    const row = await approvalRow(appr.id);
    expect(row?.status).toBe('approved');
    expect(row?.resolvedBy).toBe('api');
    expect(await jobStatus(job.id)).toBe('processing');
  });

  it('leaves a cancelled job terminal: an expired request never resurrects it', async () => {
    const job = await createJob({ status: 'cancelled' });
    const appr = await insertApproval(job.id, { expiresAt: new Date(Date.now() - 60 * 1000) });

    await expireStaleApprovals(db);

    expect((await approvalRow(appr.id))?.status).toBe('expired');
    expect(await jobStatus(job.id)).toBe('cancelled');
  });
});
