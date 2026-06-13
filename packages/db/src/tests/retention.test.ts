// retention.test.ts — unit tests for pruneOldJobs
//
// Scenario matrix:
//   (a) Old terminal job  — completed_at far in the past, status=completed
//                           with 2 tool_calls → should be pruned
//   (b) Recent terminal   — completed_at within threshold, status=failed
//                           → should remain
//   (c) Old non-terminal  — completed_at far in the past, status=processing
//                           → should remain (only terminal statuses pruned)
//
// Each test runs against a fresh spinUpTestDb to ensure complete isolation.

import { describe, it, expect, beforeAll } from 'vitest';
import { spinUpTestDb, seedMinimal } from './helpers.ts';
import type { TestDb } from './helpers.ts';
import { eq, inArray } from 'drizzle-orm';
import * as schema from '../schema/index.ts';
import { pruneOldJobs } from '../repos/retention.ts';

// ─── Shared test DB ───────────────────────────────────────────────────────────

let db: TestDb;
let seed: { userId: string; entityId: string; agentId: string; llmKeyId: string; jobId: string };

beforeAll(async () => {
  const result = await spinUpTestDb();
  db = result.db;
  seed = await seedMinimal(db);
});

// ─── Helper: insert a job with an explicit completed_at ───────────────────────

async function insertJob(
  status: string,
  completedAt: Date | null,
): Promise<string> {
  const [job] = await db
    .insert(schema.agentJobs)
    .values({
      entityId: seed.entityId,
      agentId: seed.agentId,
      channel: 'api',
      task: `retention-test ${status} ${completedAt?.toISOString() ?? 'null'}`,
      status,
      completedAt,
    })
    .returning();
  if (!job) throw new Error('Failed to insert job');
  return job.id;
}

async function insertToolCall(jobId: string, toolName: string): Promise<string> {
  const [tc] = await db
    .insert(schema.toolCalls)
    .values({
      entityId: seed.entityId,
      jobId,
      toolName,
    })
    .returning();
  if (!tc) throw new Error('Failed to insert tool_call');
  return tc.id;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('pruneOldJobs', () => {
  it('retentionDays=0 deletes nothing', async () => {
    // Insert an old completed job
    const oldDate = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000); // 100 days ago
    const jobId = await insertJob('completed', oldDate);
    const tcId = await insertToolCall(jobId, 'tool_noop');

    const result = await pruneOldJobs(db, 0);

    expect(result.jobsDeleted).toBe(0);
    expect(result.toolCallsDeleted).toBe(0);

    // Rows must still be present
    const jobs = await db.select().from(schema.agentJobs).where(eq(schema.agentJobs.id, jobId));
    expect(jobs.length).toBe(1);

    const tcs = await db.select().from(schema.toolCalls).where(eq(schema.toolCalls.id, tcId));
    expect(tcs.length).toBe(1);
  });

  it('negative retentionDays deletes nothing', async () => {
    const result = await pruneOldJobs(db, -5);
    expect(result.jobsDeleted).toBe(0);
    expect(result.toolCallsDeleted).toBe(0);
  });

  it('prunes old terminal job and its tool_calls but leaves recent + non-terminal', async () => {
    // Use a fresh DB so counts are exact and there is no cross-test leakage.
    const { db: freshDb } = await spinUpTestDb();
    const freshSeed = await seedMinimal(freshDb);

    async function freshJob(status: string, completedAt: Date | null): Promise<string> {
      const [j] = await freshDb
        .insert(schema.agentJobs)
        .values({
          entityId: freshSeed.entityId,
          agentId: freshSeed.agentId,
          channel: 'api',
          task: `ret-${status}`,
          status,
          completedAt,
        })
        .returning();
      if (!j) throw new Error('seed job failed');
      return j.id;
    }

    async function freshTc(jobId: string, toolName: string): Promise<string> {
      const [tc] = await freshDb
        .insert(schema.toolCalls)
        .values({ entityId: freshSeed.entityId, jobId, toolName })
        .returning();
      if (!tc) throw new Error('seed tc failed');
      return tc.id;
    }

    const now = Date.now();
    const threshold = 30; // days

    // (a) Old completed job — 60 days ago, 2 tool_calls → should be pruned
    const oldDate = new Date(now - 60 * 24 * 60 * 60 * 1000);
    const oldJobId = await freshJob('completed', oldDate);
    const oldTc1 = await freshTc(oldJobId, 'old_tool_1');
    const oldTc2 = await freshTc(oldJobId, 'old_tool_2');

    // (b) Recent terminal job — 5 days ago → should remain
    const recentDate = new Date(now - 5 * 24 * 60 * 60 * 1000);
    const recentJobId = await freshJob('failed', recentDate);
    const recentTc = await freshTc(recentJobId, 'recent_tool');

    // (c) Old non-terminal job — 60 days ago, status=processing → should remain
    const oldProcessingId = await freshJob('processing', oldDate);
    const oldProcessingTc = await freshTc(oldProcessingId, 'processing_tool');

    const result = await pruneOldJobs(freshDb, threshold);

    // Exact counts: only 1 prunable job with 2 tool_calls in this fresh DB
    // (the seed job has no completed_at, so it does not qualify).
    expect(result.jobsDeleted).toBe(1);
    expect(result.toolCallsDeleted).toBe(2);

    // (a) Old terminal job is gone
    const goneJobs = await freshDb
      .select()
      .from(schema.agentJobs)
      .where(eq(schema.agentJobs.id, oldJobId));
    expect(goneJobs.length).toBe(0);

    // (a) Its tool_calls are gone (via CASCADE)
    const goneTcs = await freshDb
      .select()
      .from(schema.toolCalls)
      .where(inArray(schema.toolCalls.id, [oldTc1, oldTc2]));
    expect(goneTcs.length).toBe(0);

    // (b) Recent terminal job remains
    const remainsRecent = await freshDb
      .select()
      .from(schema.agentJobs)
      .where(eq(schema.agentJobs.id, recentJobId));
    expect(remainsRecent.length).toBe(1);

    const remainsRecentTc = await freshDb
      .select()
      .from(schema.toolCalls)
      .where(eq(schema.toolCalls.id, recentTc));
    expect(remainsRecentTc.length).toBe(1);

    // (c) Old non-terminal job remains
    const remainsProcessing = await freshDb
      .select()
      .from(schema.agentJobs)
      .where(eq(schema.agentJobs.id, oldProcessingId));
    expect(remainsProcessing.length).toBe(1);

    const remainsProcessingTc = await freshDb
      .select()
      .from(schema.toolCalls)
      .where(eq(schema.toolCalls.id, oldProcessingTc));
    expect(remainsProcessingTc.length).toBe(1);
  });

  it('prunes all terminal statuses (completed, failed, cancelled)', async () => {
    // Fresh DB for exact count assertions.
    const { db: freshDb } = await spinUpTestDb();
    const freshSeed = await seedMinimal(freshDb);

    const now = Date.now();
    const oldDate = new Date(now - 60 * 24 * 60 * 60 * 1000);

    async function freshJob(status: string): Promise<string> {
      const [j] = await freshDb
        .insert(schema.agentJobs)
        .values({
          entityId: freshSeed.entityId,
          agentId: freshSeed.agentId,
          channel: 'api',
          task: `ret-${status}`,
          status,
          completedAt: oldDate,
        })
        .returning();
      if (!j) throw new Error('seed job failed');
      return j.id;
    }

    const completedId = await freshJob('completed');
    const failedId = await freshJob('failed');
    const cancelledId = await freshJob('cancelled');

    const result = await pruneOldJobs(freshDb, 30);

    // Exactly 3 terminal jobs, 0 tool_calls → the seed job has no completed_at.
    expect(result.jobsDeleted).toBe(3);
    expect(result.toolCallsDeleted).toBe(0);

    const remaining = await freshDb
      .select()
      .from(schema.agentJobs)
      .where(inArray(schema.agentJobs.id, [completedId, failedId, cancelledId]));
    expect(remaining.length).toBe(0);
  });

  it('returns zero counts when nothing qualifies for pruning', async () => {
    // Fresh db with only the seed job (which has no completed_at set)
    const { db: freshDb } = await spinUpTestDb();
    await seedMinimal(freshDb);

    const result = await pruneOldJobs(freshDb, 30);
    expect(result.jobsDeleted).toBe(0);
    expect(result.toolCallsDeleted).toBe(0);
  });
});
