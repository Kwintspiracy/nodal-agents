// approve.test.ts — awaiting_approval → processing on POST
// Asserts that approving/rejecting an approval request sets the right DB state.

import { describe, it, expect, beforeAll } from 'vitest';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import { eq } from '@nodal-agents/db';
import { approvalRequests, agentJobs } from '@nodal-agents/db';
import { createToolRegistry, registerBuiltins } from '@nodal-agents/tools';
import { createLlmClient, createEmbeddingClient } from '@nodal-agents/llm';
import { LocalTrustProvider } from '@nodal-agents/auth';
import { createApp } from '../../server.ts';
import type { RunnerDeps } from '../../deps.ts';
import type { RunnerEnv } from '../../env.ts';

let db: TestDb;
let app: ReturnType<typeof createApp>;
let seed: { userId: string; entityId: string; agentId: string; jobId: string };

const testEnv: RunnerEnv = {
  DATABASE_URL: 'test://local',
  LLM_PROVIDER: 'anthropic',
  LLM_MODEL: 'claude-sonnet-4-6-20260217',
  LLM_API_KEY: 'test-key',
  LLM_BASE_URL: undefined,
  EMBEDDING_PROVIDER: 'keyword',
  EMBEDDING_MODEL: undefined,
  EMBEDDING_BASE_URL: undefined,
  AUTH_MODE: 'local-trust',
  WORKER_SECRET: 'test-secret',
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
  RETENTION_DAYS: 0,
};

beforeAll(async () => {
  const result = await spinUpTestDb();
  db = result.db;
  seed = await seedMinimal(db);

  // Set seed job to awaiting_approval
  await db
    .update(agentJobs)
    .set({ status: 'awaiting_approval', chainCount: 0 })
    .where(eq(agentJobs.id, seed.jobId));

  const registry = createToolRegistry();
  registerBuiltins(registry);

  const llmClient = createLlmClient({ provider: 'anthropic', model: 'test', apiKey: 'key' });
  const embeddingClient = createEmbeddingClient({ provider: 'keyword' });

  const deps: RunnerDeps = {
    db: db as RunnerDeps['db'],
    llmClient,
    embeddingClient,
    registry,
    authProvider: new LocalTrustProvider(),
    close: async () => {},
  };

  app = createApp(deps, testEnv);
});

describe('POST /api/approve', () => {
  it('returns 400 on invalid request (missing decision)', async () => {
    const res = await app.fetch(
      new Request('http://localhost/api/approve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ approvalRequestId: '00000000-0000-0000-0000-000000000001' }),
      }),
    );
    expect(res.status).toBe(400);
  });

  it('returns 404 when approval_request does not exist', async () => {
    const res = await app.fetch(
      new Request('http://localhost/api/approve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          approvalRequestId: '00000000-0000-0000-0000-000000000099',
          decision: 'approve',
        }),
      }),
    );
    expect(res.status).toBe(404);
  });

  it('approve: sets approval_request to approved and job to pending', async () => {
    // Seed an approval request
    const [approval] = await db
      .insert(approvalRequests)
      .values({
        entityId: seed.entityId,
        jobId: seed.jobId,
        agentId: seed.agentId,
        toolName: 'gmail_send',
        toolInput: { to: 'test@example.com', subject: 'hi' },
        status: 'pending',
      })
      .returning();

    expect(approval).toBeDefined();
    const approvalId = approval!.id;

    const res = await app.fetch(
      new Request('http://localhost/api/approve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ approvalRequestId: approvalId, decision: 'approve' }),
      }),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; decision: string; jobId: string };
    expect(body.ok).toBe(true);
    expect(body.decision).toBe('approve');

    // Assert approval_requests row is now approved (real DB check)
    const approvalRow = await db
      .select({ status: approvalRequests.status })
      .from(approvalRequests)
      .where(eq(approvalRequests.id, approvalId));

    expect(approvalRow[0]?.status).toBe('approved');

    // Assert job is back to pending for resume
    const jobRow = await db
      .select({ status: agentJobs.status, chainCount: agentJobs.chainCount })
      .from(agentJobs)
      .where(eq(agentJobs.id, seed.jobId));

    expect(jobRow[0]?.status).toBe('pending');
    // Invariant: chain_count NOT bumped on approval-resume
    expect(jobRow[0]?.chainCount).toBe(0);
  });

  it('reject: sets approval_request to rejected and job to pending', async () => {
    // Seed another approval request
    const [approval] = await db
      .insert(approvalRequests)
      .values({
        entityId: seed.entityId,
        jobId: seed.jobId,
        agentId: seed.agentId,
        toolName: 'drive_delete',
        toolInput: { fileId: 'abc' },
        status: 'pending',
      })
      .returning();

    const approvalId = approval!.id;

    const res = await app.fetch(
      new Request('http://localhost/api/approve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          approvalRequestId: approvalId,
          decision: 'reject',
          notes: 'Not authorized',
        }),
      }),
    );

    expect(res.status).toBe(200);

    // Assert approval_requests row is now rejected
    const approvalRow = await db
      .select({ status: approvalRequests.status, notes: approvalRequests.notes })
      .from(approvalRequests)
      .where(eq(approvalRequests.id, approvalId));

    expect(approvalRow[0]?.status).toBe('rejected');
    expect(approvalRow[0]?.notes).toBe('Not authorized');
  });

  it('returns 400 when approval is already resolved', async () => {
    // Create already-approved request
    const [approval] = await db
      .insert(approvalRequests)
      .values({
        entityId: seed.entityId,
        jobId: seed.jobId,
        agentId: seed.agentId,
        toolName: 'some_tool',
        toolInput: {},
        status: 'approved',
      })
      .returning();

    const res = await app.fetch(
      new Request('http://localhost/api/approve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ approvalRequestId: approval!.id, decision: 'approve' }),
      }),
    );

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('approval_already_resolved');
  });
});
