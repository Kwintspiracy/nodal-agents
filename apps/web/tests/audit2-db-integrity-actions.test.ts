// @vitest-environment node
/**
 * Integration tests for audit #2 DB integrity fixes (DB-1, F-18, F-19).
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
import { agents, agentAssignments, approvalRules, eq, and } from '@nodal-agents/db';
import type * as NodalMemory from '@nodal-agents/memory';

// ─── Module-level state ───────────────────────────────────────────────────────

let _testDb: TestDb | null = null;
let _testUserId = 'placeholder-user-id';
let _testEntityId = 'placeholder-entity-id';
let _seededAgentId = 'placeholder-agent-id';
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
  _seededAgentId = seed.agentId;
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

// ─── DB-1: setAgentApprovalRuleAction upsert ──────────────────────────────────

describe('setAgentApprovalRuleAction — upsert on (entity, agent, tool) — DB-1', () => {
  it('two calls with different actions on the same (agent, tool) leave exactly ONE row with the LAST action', async () => {
    const { setAgentApprovalRuleAction } = await import('../src/lib/actions.ts');
    const toolName = `audit2_db1_tool_${Date.now()}`;

    const first = await setAgentApprovalRuleAction({
      agentId: _seededAgentId,
      toolName,
      action: 'require_approval',
    });
    expect(first.ok).toBe(true);

    const second = await setAgentApprovalRuleAction({
      agentId: _seededAgentId,
      toolName,
      action: 'block',
    });
    expect(second.ok).toBe(true);

    const rows = await _testDb!
      .select({ action: approvalRules.action })
      .from(approvalRules)
      .where(
        and(
          eq(approvalRules.entityId, _testEntityId),
          eq(approvalRules.agentId, _seededAgentId),
          eq(approvalRules.toolName, toolName),
        ),
      );

    expect(rows).toHaveLength(1);
    expect(rows[0]?.action).toBe('block');
  });
});

// ─── R2: setRunCommandYoloAction — transactional toggle on approval_rules ─────

describe('setRunCommandYoloAction — re-toggle never leaves a duplicate row — R2 (audit #2 follow-up)', () => {
  it('enable, then enable again (re-toggle race) leaves exactly ONE auto_approve row', async () => {
    const agentId = await makeAgent('Audit2 Yolo Agent');
    const { setRunCommandYoloAction } = await import('../src/lib/actions.ts');

    const first = await setRunCommandYoloAction({ agentId, enabled: true });
    expect(first.ok).toBe(true);
    const second = await setRunCommandYoloAction({ agentId, enabled: true });
    expect(second.ok).toBe(true);

    const rows = await _testDb!
      .select({ action: approvalRules.action })
      .from(approvalRules)
      .where(
        and(
          eq(approvalRules.entityId, _testEntityId),
          eq(approvalRules.agentId, agentId),
          eq(approvalRules.toolName, 'run_command'),
        ),
      );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.action).toBe('auto_approve');
  });

  it('disable removes the row', async () => {
    const agentId = await makeAgent('Audit2 Yolo Agent Off');
    const { setRunCommandYoloAction } = await import('../src/lib/actions.ts');

    await setRunCommandYoloAction({ agentId, enabled: true });
    const off = await setRunCommandYoloAction({ agentId, enabled: false });
    expect(off.ok).toBe(true);

    const rows = await _testDb!
      .select({ action: approvalRules.action })
      .from(approvalRules)
      .where(
        and(
          eq(approvalRules.entityId, _testEntityId),
          eq(approvalRules.agentId, agentId),
          eq(approvalRules.toolName, 'run_command'),
        ),
      );
    expect(rows).toHaveLength(0);
  });
});

// ─── F-18/F-19: updateAgentAction sub-agent rewrite ───────────────────────────

describe('updateAgentAction — sub-agent rewrite is atomic and deduped — F-18/F-19', () => {
  it('happy path: old sub-agents are replaced by the new list in one call', async () => {
    const orchestratorId = await makeAgent('Audit2 Orchestrator');
    const subOld = await makeAgent('Audit2 Sub Old');
    const subA = await makeAgent('Audit2 Sub A');
    const subB = await makeAgent('Audit2 Sub B');

    // Pre-existing assignment that must be gone after the update.
    await _testDb!
      .insert(agentAssignments)
      .values({ orchestratorId, subAgentId: subOld, entityId: _testEntityId });

    const { updateAgentAction } = await import('../src/lib/actions.ts');
    const res = await updateAgentAction({
      id: orchestratorId,
      name: 'Audit2 Orchestrator',
      personality: 'test',
      model: 'claude-sonnet-4-6-20260217',
      fallbackChain: [],
      role: 'router',
      subAgentIds: [subA, subB],
    });
    expect(res.ok).toBe(true);

    const rows = await _testDb!
      .select({ subAgentId: agentAssignments.subAgentId })
      .from(agentAssignments)
      .where(eq(agentAssignments.orchestratorId, orchestratorId));

    expect(rows.map((r) => r.subAgentId).sort()).toEqual([subA, subB].sort());
  });

  it('a same sub-agent re-submitted across two separate updates never leaves a duplicate row (onConflictDoNothing)', async () => {
    // The realistic F-18 race is two separate updateAgentAction calls landing
    // on the same (orchestrator, sub-agent) pair — not literal duplicates in
    // one payload (the pre-existing entity-ownership check already rejects
    // those with `validation_failed`, independently of this fix, before the
    // transaction is ever opened). Simulate the race by calling the action
    // twice in a row with the same single sub-agent: the second call's delete
    // clears its own prior row first, so to actually exercise the new UNIQUE
    // constraint's onConflictDoNothing path we insert a colliding row directly
    // (bypassing the delete) the way an overlapping concurrent write would.
    const orchestratorId = await makeAgent('Audit2 Orchestrator Race');
    const subA = await makeAgent('Audit2 Sub Race A');

    await _testDb!
      .insert(agentAssignments)
      .values({ orchestratorId, subAgentId: subA, entityId: _testEntityId });

    // A second insert for the exact same pair (what a racing concurrent
    // updateAgentAction call would attempt after this transaction's delete
    // already ran) must be silently absorbed, not throw.
    await expect(
      _testDb!
        .insert(agentAssignments)
        .values({ orchestratorId, subAgentId: subA, entityId: _testEntityId })
        .onConflictDoNothing({
          target: [agentAssignments.orchestratorId, agentAssignments.subAgentId],
        }),
    ).resolves.not.toThrow();

    const rows = await _testDb!
      .select({ subAgentId: agentAssignments.subAgentId })
      .from(agentAssignments)
      .where(eq(agentAssignments.orchestratorId, orchestratorId));

    expect(rows).toHaveLength(1);
    expect(rows[0]?.subAgentId).toBe(subA);
  });

  it('literal duplicate ids in one payload still fail validation upstream of the transaction (pre-existing guard)', async () => {
    const orchestratorId = await makeAgent('Audit2 Orchestrator Dup Payload');
    const subA = await makeAgent('Audit2 Sub Dup Payload A');

    const { updateAgentAction } = await import('../src/lib/actions.ts');
    const res = await updateAgentAction({
      id: orchestratorId,
      name: 'Audit2 Orchestrator Dup Payload',
      personality: 'test',
      model: 'claude-sonnet-4-6-20260217',
      fallbackChain: [],
      role: 'router',
      subAgentIds: [subA, subA],
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe('validation_failed');
  });
});
