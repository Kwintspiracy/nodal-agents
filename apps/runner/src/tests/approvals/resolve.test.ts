// resolve.test.ts — resolveApprovalDecision: atomic claim on the resolution
// UPDATE itself (F-14). Two concurrent resolutions of the same approval must
// not both "win" — only one flips the row, the other is told already_resolved.

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import { eq } from '@nodal-agents/db';
import { approvalRequests, agentJobs } from '@nodal-agents/db';
import { resolveApprovalDecision } from '../../approvals/resolve.ts';
import type { RunnerDeps } from '../../deps.ts';
import type { RunnerEnv } from '../../env.ts';

let db: TestDb;
let seed: { entityId: string; agentId: string; jobId: string };

const testEnv: RunnerEnv = {
  DATABASE_URL: 'test://local',
  LLM_PROVIDER: 'anthropic',
  LLM_MODEL: 'test',
  LLM_API_KEY: 'k',
  LLM_BASE_URL: undefined,
  EMBEDDING_PROVIDER: 'keyword',
  EMBEDDING_MODEL: undefined,
  EMBEDDING_BASE_URL: undefined,
  AUTH_MODE: 'local-trust',
  WORKER_SECRET: 's',
  BEARER_TOKEN: undefined,
  PORT: 3099,
  BIND: '127.0.0.1',
  APP_URL: 'http://localhost:3099',
  NODE_ENV: 'test',
  REFLECTION_ENABLED: 'false',
  REFLECTION_MIN_TURNS: 3,
  REFLECTION_MAX_PER_HOUR: 6,
  REFLECTION_MAX_TURNS: 3,
  CURATOR_STALE_DAYS: 30,
  CURATOR_ARCHIVE_DAYS: 90,
  CURATOR_MIN_SKILLS: 5,
  CURATOR_INTERVAL_DAYS: 7,
  CURATOR_MAX_TURNS: 4,
  CURATOR_MEMORY_STALE_DAYS: 60,
  CURATOR_MEMORY_IMPORTANCE_MAX: 2,
  CURATOR_MEMORY_MIN: 8,
  MEMORY_CURATION_ENABLED: '',
  RETENTION_DAYS: 0,
  NODALAI_APPROVAL_GRACE_MS: 0,
};

function makeDeps(): RunnerDeps {
  return {
    db: db as unknown as RunnerDeps['db'],
    llmClient: {} as RunnerDeps['llmClient'],
    embeddingClient: {} as RunnerDeps['embeddingClient'],
    registry: {} as RunnerDeps['registry'],
    authProvider: {} as RunnerDeps['authProvider'],
    close: async () => {},
  };
}

beforeAll(async () => {
  const result = await spinUpTestDb();
  db = result.db;
  const minimal = await seedMinimal(db);
  seed = { entityId: minimal.entityId, agentId: minimal.agentId, jobId: minimal.jobId };
});

// A successful resolve now requires the job to still be `awaiting_approval`
// (B1) and flips it to `pending`. Reset before each test so the shared seed
// job's status doesn't leak between tests — precondition of the flow, not
// assertion data.
beforeEach(async () => {
  await db
    .update(agentJobs)
    .set({ status: 'awaiting_approval' })
    .where(eq(agentJobs.id, seed.jobId));
});

describe('resolveApprovalDecision — atomic claim (F-14)', () => {
  it('returns already_resolved (not an error) for a request that is not pending', async () => {
    const [approval] = await db
      .insert(approvalRequests)
      .values({
        entityId: seed.entityId,
        jobId: seed.jobId,
        agentId: seed.agentId,
        toolName: 'gmail_send',
        toolInput: {},
        status: 'rejected',
      })
      .returning();

    const result = await resolveApprovalDecision(makeDeps(), testEnv, {
      approvalRequestId: approval!.id,
      decision: 'approve',
      resolvedBy: 'api',
    });

    expect(result).toEqual({ ok: false, code: 'already_resolved', status: 'rejected' });
  });

  it('two concurrent resolutions of the same pending approval: exactly one wins, the other gets already_resolved', async () => {
    const [approval] = await db
      .insert(approvalRequests)
      .values({
        entityId: seed.entityId,
        jobId: seed.jobId,
        agentId: seed.agentId,
        toolName: 'run_command',
        toolInput: { command: 'ls' },
        status: 'pending',
      })
      .returning();
    const approvalId = approval!.id;

    const [resultA, resultB] = await Promise.all([
      resolveApprovalDecision(makeDeps(), testEnv, {
        approvalRequestId: approvalId,
        decision: 'approve',
        resolvedBy: 'telegram',
      }),
      resolveApprovalDecision(makeDeps(), testEnv, {
        approvalRequestId: approvalId,
        decision: 'reject',
        resolvedBy: 'api',
      }),
    ]);

    const outcomes = [resultA, resultB];
    const winners = outcomes.filter((r) => r.ok);
    const losers = outcomes.filter((r) => !r.ok);

    // Exactly one caller's UPDATE actually flipped the row — real data-layer
    // assertion, not a call count.
    expect(winners.length).toBe(1);
    expect(losers.length).toBe(1);
    expect(losers[0]).toMatchObject({ ok: false, code: 'already_resolved' });

    // The persisted status matches whichever decision actually won — the row
    // was not silently overwritten by the loser after the winner committed.
    const [row] = await db
      .select({ status: approvalRequests.status, resolvedBy: approvalRequests.resolvedBy })
      .from(approvalRequests)
      .where(eq(approvalRequests.id, approvalId));

    const winnerDecision = (winners[0] as { decision: 'approve' | 'reject' }).decision;
    expect(row?.status).toBe(winnerDecision === 'approve' ? 'approved' : 'rejected');
    expect(row?.resolvedBy).toBe(winnerDecision === 'approve' ? 'telegram' : 'api');
  });

  it('B1: a late approval on a CANCELLED job is refused — the job is not resurrected', async () => {
    // The user cancelled the job while an approval sat pending; a stale
    // "Approve" tap (old Telegram card / reopened tab) must NOT flip the
    // cancelled job back to pending and run its gated tool.
    const [approval] = await db
      .insert(approvalRequests)
      .values({
        entityId: seed.entityId,
        jobId: seed.jobId,
        agentId: seed.agentId,
        toolName: 'run_command',
        toolInput: { command: 'rm -rf important' },
        status: 'pending',
      })
      .returning();

    // Simulate the cancel that landed after the approval was created.
    await db.update(agentJobs).set({ status: 'cancelled' }).where(eq(agentJobs.id, seed.jobId));

    const result = await resolveApprovalDecision(makeDeps(), testEnv, {
      approvalRequestId: approval!.id,
      decision: 'approve',
      resolvedBy: 'telegram',
    });

    // Refused, and the reported status is the one the job actually holds.
    expect(result).toMatchObject({ ok: false, code: 'job_not_resumable', status: 'cancelled' });

    // The job stayed cancelled — never resurrected to pending.
    const [row] = await db
      .select({ status: agentJobs.status })
      .from(agentJobs)
      .where(eq(agentJobs.id, seed.jobId));
    expect(row?.status).toBe('cancelled');
  });

  it('Lot A1: job already back in-process (processing) when resolved — ok:true, resumed:"in_process", no re-trigger', async () => {
    // Mirrors the grace-window race: the job's OWN executeJob is mid grace-
    // window poll (or already resumed by a previous decision) — status is
    // `processing`, NOT `awaiting_approval`. The awaiting_approval → pending
    // UPDATE therefore touches 0 rows, but the decision IS recorded (the
    // approval_requests row is resolved) and the in-process runner will pick
    // it up on its own — resolveApprovalDecision must say so instead of
    // reporting job_not_resumable.
    await db.update(agentJobs).set({ status: 'processing' }).where(eq(agentJobs.id, seed.jobId));

    const [approval] = await db
      .insert(approvalRequests)
      .values({
        entityId: seed.entityId,
        jobId: seed.jobId,
        agentId: seed.agentId,
        toolName: 'run_command',
        toolInput: { command: 'echo in-process' },
        status: 'pending',
      })
      .returning();

    const result = await resolveApprovalDecision(makeDeps(), testEnv, {
      approvalRequestId: approval!.id,
      decision: 'approve',
      resolvedBy: 'api',
    });

    expect(result).toMatchObject({ ok: true, decision: 'approve', resumed: 'in_process' });

    // The decision landed on the approval row itself...
    const [approvalRow] = await db
      .select({ status: approvalRequests.status })
      .from(approvalRequests)
      .where(eq(approvalRequests.id, approval!.id));
    expect(approvalRow?.status).toBe('approved');

    // ...but the job's own status is untouched — no separate trigger raced
    // the in-process runner.
    const [jobRow] = await db
      .select({ status: agentJobs.status })
      .from(agentJobs)
      .where(eq(agentJobs.id, seed.jobId));
    expect(jobRow?.status).toBe('processing');
  });

  it('resolving an unknown approval id returns approval_not_found', async () => {
    const result = await resolveApprovalDecision(makeDeps(), testEnv, {
      approvalRequestId: '00000000-0000-0000-0000-000000000099',
      decision: 'approve',
      resolvedBy: 'api',
    });
    expect(result).toEqual({ ok: false, code: 'approval_not_found' });
  });
});
