// @vitest-environment node
/**
 * Integration tests for listCodingProcessesAction (Code tab — étape V).
 *
 * Uses a real pglite in-memory DB (spinUpTestDb / seedMinimal from
 * @nodal-agents/db/test-utils) so assertions target actual DB rows — not
 * mocks of mocks. Mirrors the harness in root-agent-actions.test.ts.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { _setMasterKeyForTests, _resetMasterKeyCacheForTests } from '@nodal-agents/secrets';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import { agents, agentJobs, cliRuns, toolCalls } from '@nodal-agents/db';
import type * as NodalMemory from '@nodal-agents/memory';

// ─── Module-level state ───────────────────────────────────────────────────────

let _testDb: TestDb | null = null;
let _testUserId = 'placeholder-user-id';
let _testEntityId = 'placeholder-entity-id';
let _llmKeyId = 'placeholder-llm-key-id';

// ─── Mocks ────────────────────────────────────────────────────────────────────

vi.mock('server-only', () => ({}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

vi.mock('@/lib/server.ts', () => ({
  getDb: () => {
    if (!_testDb) throw new Error('Test DB not initialized');
    return _testDb;
  },
  getAuthProvider: () => ({
    getSession: async (_req: Request) => ({
      userId: _testUserId,
      entityId: _testEntityId,
    }),
    handleAuthRequest: null,
  }),
  requireAuth: vi.fn().mockImplementation(async () => ({
    userId: _testUserId,
    entityId: _testEntityId,
  })),
  requireAuthWithEntity: vi.fn(),
  requireUserWithEntity: vi.fn(),
  applyActiveEntity: vi.fn(async (session: unknown) => session),
  ACTIVE_ENTITY_COOKIE: 'nodalai_active_entity',
}));

vi.mock('../src/lib/cli-config.ts', () => ({
  NODALAI_CONFIG_PATH: '/tmp/test/config.json',
  readNodalaiConfig: vi.fn(),
  mergeNodalaiConfig: vi.fn(),
}));

vi.mock('@nodal-agents/memory', async () => {
  const actual = await vi.importActual<typeof NodalMemory>('@nodal-agents/memory');
  return {
    ...actual,
    listMemories: vi.fn(),
    deleteMemory: vi.fn(),
    updateMemory: vi.fn(),
  };
});

vi.mock('@nodal-agents/adapter-mcp', () => ({
  connectMcp: vi.fn(),
}));

// ─── Setup / teardown ─────────────────────────────────────────────────────────

beforeAll(async () => {
  process.env['DATABASE_URL'] = 'postgres://placeholder:5432/placeholder';
  process.env['AUTH_MODE'] = 'local-trust';
  process.env['RUNNER_URL'] = 'http://localhost:3001';
  process.env['WORKER_SECRET'] = 'test-bearer-789';

  _setMasterKeyForTests(randomBytes(32));

  const { db } = await spinUpTestDb();
  _testDb = db;

  const seed = await seedMinimal(db);
  _testUserId = seed.userId;
  _testEntityId = seed.entityId;
  _llmKeyId = seed.llmKeyId;
});

afterAll(() => {
  _resetMasterKeyCacheForTests();
  _testDb = null;
  vi.restoreAllMocks();
});

async function makeAgent(name: string): Promise<string> {
  const [row] = await _testDb!
    .insert(agents)
    .values({
      entityId: _testEntityId,
      name,
      slug: `${name.toLowerCase().replace(/\s+/g, '-')}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      personality: 'test',
      llmKeyId: _llmKeyId,
    })
    .returning();
  if (!row) throw new Error(`Failed to seed agent ${name}`);
  return row.id;
}

async function makeJob(agentId: string, status: string, parentJobId?: string): Promise<string> {
  const [row] = await _testDb!
    .insert(agentJobs)
    .values({
      entityId: _testEntityId,
      agentId,
      status,
      channel: 'api',
      task: 'Fix the flaky auth test',
      parentJobId: parentJobId ?? null,
    })
    .returning();
  if (!row) throw new Error('Failed to seed job');
  return row.id;
}

describe('listCodingProcessesAction', () => {
  it('a job with cli_runs + cli:Edit tool_calls surfaces with the right stage/cost/files', async () => {
    const agentId = await makeAgent('Audit Code Agent');
    const jobId = await makeJob(agentId, 'processing');

    await _testDb!.insert(cliRuns).values({
      entityId: _testEntityId,
      agentId,
      jobId,
      provider: 'claude',
      mode: 'write',
      costUsd: 0.42,
    });

    // Two edits to the SAME file (must dedupe to 1) + one edit to a second file.
    await _testDb!.insert(toolCalls).values([
      {
        entityId: _testEntityId,
        jobId,
        toolName: 'cli:Edit',
        toolInput: { file_path: '/repo/src/auth.ts', old_string: 'a', new_string: 'b' },
        toolOutput: 'ok',
      },
      {
        entityId: _testEntityId,
        jobId,
        toolName: 'cli:Edit',
        toolInput: { file_path: '/repo/src/auth.ts', old_string: 'b', new_string: 'c' },
        toolOutput: 'ok',
      },
      {
        entityId: _testEntityId,
        jobId,
        toolName: 'cli:Write',
        toolInput: { file_path: '/repo/src/auth.test.ts', content: 'test content' },
        toolOutput: 'ok',
      },
    ]);

    const { listCodingProcessesAction } = await import('../src/lib/actions.ts');
    const result = await listCodingProcessesAction();
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const row = result.data.find((r) => r.id === jobId);
    expect(row).toBeTruthy();
    expect(row?.kind).toBe('job');
    expect(row?.stage).toBe('coding');
    expect(row?.costUsd).toBeCloseTo(0.42, 5);
    expect(row?.filesChanged).toBe(2);
    expect(row?.agentId).toBe(agentId);
  });

  it('an approve review_verdict on a direct child marks the completed parent "done_approved"', async () => {
    const agentId = await makeAgent('Audit Code Reviewer Parent Agent');
    const parentJobId = await makeJob(agentId, 'completed');
    const childJobId = await makeJob(agentId, 'completed', parentJobId);

    // The parent must be a CANDIDATE job — give it a cli_runs row (path (a) of
    // the plan: "dont l'id apparaît dans cli_runs.job_id").
    await _testDb!.insert(cliRuns).values({
      entityId: _testEntityId,
      agentId,
      jobId: parentJobId,
      provider: 'claude',
      mode: 'write',
      costUsd: 0.1,
    });

    await _testDb!.insert(toolCalls).values({
      entityId: _testEntityId,
      jobId: childJobId,
      toolName: 'review_verdict',
      toolInput: { summary: 'Looks good' },
      toolOutput: JSON.stringify({
        verdict: 'approve',
        summary: 'Looks good',
        findings: [],
        counts: { blocking: 0 },
      }),
    });

    const { listCodingProcessesAction } = await import('../src/lib/actions.ts');
    const result = await listCodingProcessesAction();
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const parentRow = result.data.find((r) => r.id === parentJobId);
    expect(parentRow).toBeTruthy();
    expect(parentRow?.stage).toBe('done_approved');

    // The child itself is not a candidate job (no cli_runs row, no code_task
    // tool_call of its own) — it should not appear as its own list entry.
    const childRow = result.data.find((r) => r.id === childJobId);
    expect(childRow).toBeUndefined();
  });

  it('a completed job with no review_verdict anywhere is plain "done"', async () => {
    const agentId = await makeAgent('Audit Code Plain Done Agent');
    const jobId = await makeJob(agentId, 'completed');
    await _testDb!.insert(cliRuns).values({
      entityId: _testEntityId,
      agentId,
      jobId,
      provider: 'claude',
      mode: 'read',
      costUsd: 0.05,
    });

    const { listCodingProcessesAction } = await import('../src/lib/actions.ts');
    const result = await listCodingProcessesAction();
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const row = result.data.find((r) => r.id === jobId);
    expect(row?.stage).toBe('done');
  });

  it('a failed job surfaces with stage "failed"', async () => {
    const agentId = await makeAgent('Audit Code Failed Agent');
    const jobId = await makeJob(agentId, 'failed');
    await _testDb!.insert(cliRuns).values({
      entityId: _testEntityId,
      agentId,
      jobId,
      provider: 'claude',
      mode: 'write',
      costUsd: 0.02,
    });

    const { listCodingProcessesAction } = await import('../src/lib/actions.ts');
    const result = await listCodingProcessesAction();
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const row = result.data.find((r) => r.id === jobId);
    expect(row?.stage).toBe('failed');
  });
});
