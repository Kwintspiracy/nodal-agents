// approve.test.ts — awaiting_approval → processing on POST
// Asserts that approving/rejecting an approval request sets the right DB state.

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import { eq } from '@nodal-agents/db';
import { approvalRequests, agentJobs, entities } from '@nodal-agents/db';
import { createToolRegistry, registerBuiltins } from '@nodal-agents/tools';
import { createLlmClient, createEmbeddingClient } from '@nodal-agents/llm';
import { LocalTrustProvider } from '@nodal-agents/auth';
import type { AuthProvider, AuthSession } from '@nodal-agents/auth';
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
  SKILL_UPDATE_CHECK_INTERVAL_HOURS: 24,
  SKILL_UPDATE_CHECK_BATCH_SIZE: 10,
  NODALAI_APPROVAL_GRACE_MS: 0,
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

// Reset the seed job to `awaiting_approval` before EACH test: resolving an
// approval now legitimately requires the job to still be awaiting it (B1), and
// each resolve flips it to `pending`. Without this reset the second test would
// see the status the first left behind — a pre-existing isolation gap the B1
// guard exposed. This is a precondition of the flow, not assertion data.
beforeEach(async () => {
  await db
    .update(agentJobs)
    .set({ status: 'awaiting_approval', chainCount: 0 })
    .where(eq(agentJobs.id, seed.jobId));
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

// ─── Entity authorization (findings #4/#5) ─────────────────────────────────
//
// Sprint 1 (finding #2) already scoped the runner-direct IDOR at the resolve
// core. This proves the SAME IDOR is closed from the HTTP boundary too: an
// untrusted session bearer-token caller cannot resolve an approval belonging
// to another entity by GUID alone, while a trusted WORKER_SECRET caller (the
// web, which already pre-checks server-side) keeps the pre-existing unscoped
// lookup.

describe('POST /api/approve — entity authorization (bearer-token mode)', () => {
  let dbZ: TestDb;
  let appBearer: ReturnType<typeof createApp>;
  let seedZ: { userId: string; entityId: string; agentId: string; jobId: string };
  let entityW: string;
  let jobW: string;

  class StubSessionAuthProvider implements AuthProvider {
    constructor(private readonly session: AuthSession) {}
    getSession(req: Request): Promise<AuthSession | null> {
      // Mirrors production: a WORKER_SECRET server-to-server call carries no
      // user cookie/session; only an explicit test marker simulates one.
      if (req.headers.get('x-test-session') === '1') {
        return Promise.resolve(this.session);
      }
      return Promise.resolve(null);
    }
  }

  beforeAll(async () => {
    const result = await spinUpTestDb();
    dbZ = result.db;
    seedZ = await seedMinimal(dbZ);

    // Entity W: a separate tenant with its own job, holding an approval a
    // caller scoped to entity Z must never be able to resolve.
    const [entityWRow] = await dbZ
      .insert(entities)
      .values({ userId: seedZ.userId, name: 'Entity W', slug: `entity-w-${crypto.randomUUID()}` })
      .returning();
    entityW = entityWRow!.id;

    const [jobWRow] = await dbZ
      .insert(agentJobs)
      .values({ entityId: entityW, channel: 'api', task: 'Entity W task' })
      .returning();
    jobW = jobWRow!.id;

    const registry = createToolRegistry();
    registerBuiltins(registry);
    const llmClient = createLlmClient({ provider: 'anthropic', model: 'test', apiKey: 'key' });
    const embeddingClient = createEmbeddingClient({ provider: 'keyword' });

    const depsBearer: RunnerDeps = {
      db: dbZ as RunnerDeps['db'],
      llmClient,
      embeddingClient,
      registry,
      authProvider: new StubSessionAuthProvider({
        userId: seedZ.userId,
        entityId: seedZ.entityId,
      }),
      close: async () => {},
    };

    appBearer = createApp(depsBearer, { ...testEnv, AUTH_MODE: 'bearer-token' });
  });

  it('untrusted session caller cannot resolve another entity approval (not_found, no effect)', async () => {
    const [approval] = await dbZ
      .insert(approvalRequests)
      .values({
        entityId: entityW,
        jobId: jobW,
        toolName: 'run_command',
        toolInput: { command: 'rm -rf /' },
        status: 'pending',
      })
      .returning();
    const approvalId = approval!.id;

    const res = await appBearer.fetch(
      new Request('http://localhost/api/approve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-test-session': '1' },
        body: JSON.stringify({ approvalRequestId: approvalId, decision: 'approve' }),
      }),
    );

    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('approval_not_found');

    // No effect: entity W's approval and job are untouched.
    const approvalRow = await dbZ
      .select({ status: approvalRequests.status })
      .from(approvalRequests)
      .where(eq(approvalRequests.id, approvalId));
    expect(approvalRow[0]?.status).toBe('pending');

    const jobRow = await dbZ
      .select({ status: agentJobs.status })
      .from(agentJobs)
      .where(eq(agentJobs.id, jobW));
    expect(jobRow[0]?.status).toBe('pending');
  });

  it('untrusted session caller can resolve its OWN entity approval', async () => {
    const [ownJob] = await dbZ
      .insert(agentJobs)
      .values({
        entityId: seedZ.entityId,
        agentId: seedZ.agentId,
        channel: 'api',
        task: 'own task',
        status: 'awaiting_approval',
      })
      .returning();
    const [approval] = await dbZ
      .insert(approvalRequests)
      .values({
        entityId: seedZ.entityId,
        jobId: ownJob!.id,
        agentId: seedZ.agentId,
        toolName: 'gmail_send',
        toolInput: {},
        status: 'pending',
      })
      .returning();

    const res = await appBearer.fetch(
      new Request('http://localhost/api/approve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-test-session': '1' },
        body: JSON.stringify({ approvalRequestId: approval!.id, decision: 'approve' }),
      }),
    );

    expect(res.status).toBe(200);
    const approvalRow = await dbZ
      .select({ status: approvalRequests.status })
      .from(approvalRequests)
      .where(eq(approvalRequests.id, approval!.id));
    expect(approvalRow[0]?.status).toBe('approved');
  });

  it('trusted WORKER_SECRET caller keeps unchanged unscoped resolution', async () => {
    // jobW is 'pending' by default (asserted untouched by the cross-entity test
    // above); a successful resolve now requires it to be awaiting the approval
    // (B1), so put it in that state first — this test's precondition.
    await dbZ.update(agentJobs).set({ status: 'awaiting_approval' }).where(eq(agentJobs.id, jobW));

    const [approval] = await dbZ
      .insert(approvalRequests)
      .values({
        entityId: entityW,
        jobId: jobW,
        toolName: 'run_command',
        toolInput: { command: 'ls' },
        status: 'pending',
      })
      .returning();

    const res = await appBearer.fetch(
      new Request('http://localhost/api/approve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-secret' },
        body: JSON.stringify({ approvalRequestId: approval!.id, decision: 'approve' }),
      }),
    );

    expect(res.status).toBe(200);
    const approvalRow = await dbZ
      .select({ status: approvalRequests.status })
      .from(approvalRequests)
      .where(eq(approvalRequests.id, approval!.id));
    expect(approvalRow[0]?.status).toBe('approved');
  });
});
