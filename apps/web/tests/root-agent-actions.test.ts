// @vitest-environment node
/**
 * Integration tests for getRootConfigAction + setRootAgentAction.
 *
 * Uses a real pglite in-memory DB (spinUpTestDb / seedMinimal from
 * @nodal-agents/db/test-utils) so assertions target actual DB rows —
 * not mocks of mocks.
 *
 * Wave 2b — V4 ROOT agent, 2026-05-29.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { _setMasterKeyForTests, _resetMasterKeyCacheForTests } from '@nodal-agents/secrets';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import { agents, entities, entityMembers, approvalRules, eq, and, inArray } from '@nodal-agents/db';
import { META_TOOL_NAMES } from '@nodal-agents/shared';

// ─── Module-level state ───────────────────────────────────────────────────────

let _testDb: TestDb | null = null;
let _testUserId = 'placeholder-user-id';
let _testEntityId = 'placeholder-entity-id';
// Seeded orchestrator agent id — set in beforeAll after seeding.
let _orchestratorId = 'placeholder-orchestrator-id';
// Seeded non-orchestrator agent id (the one from seedMinimal).
let _workerAgentId = 'placeholder-worker-id';

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
  requireUser: vi.fn(),
  requireUserWithEntity: vi.fn(),
  applyActiveEntity: vi.fn(async (session: unknown) => session),
  ACTIVE_ENTITY_COOKIE: 'nodalai_active_entity',
}));

// cli-config touches the filesystem — stub it out.
vi.mock('../src/lib/cli-config.ts', () => ({
  NODALAI_CONFIG_PATH: '/tmp/test/config.json',
  readNodalaiConfig: vi.fn(),
  mergeNodalaiConfig: vi.fn(),
}));

// memory package has its own complex chain — stub the public API directly.
vi.mock('@nodal-agents/memory', async () => {
  const actual =
    await vi.importActual<typeof import('@nodal-agents/memory')>('@nodal-agents/memory');
  return {
    ...actual,
    listMemories: vi.fn(),
    deleteMemory: vi.fn(),
    updateMemory: vi.fn(),
  };
});

// MCP adapter goes to a live server in integration — stub it.
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

  // Seed a minimal set of rows (user, entity, member, worker agent, job).
  const seed = await seedMinimal(db);
  _testUserId = seed.userId;
  _testEntityId = seed.entityId;
  _workerAgentId = seed.agentId; // worker (role='agent') from seedMinimal

  // seedMinimal does not insert an entity_members row — add one so the
  // membership guard in setRootAgentAction passes.
  await db
    .insert(entityMembers)
    .values({ entityId: seed.entityId, userId: seed.userId, role: 'owner' });

  // Insert an orchestrator agent for use in positive-path tests.
  const [orch] = await db
    .insert(agents)
    .values({
      entityId: seed.entityId,
      name: 'Test Orchestrator',
      slug: `test-orchestrator-${Date.now()}`,
      personality: 'I orchestrate.',
      role: 'orchestrator',
      orchestratorMode: 'router',
      llmKeyId: seed.llmKeyId,
    })
    .returning();
  if (!orch) throw new Error('Failed to seed orchestrator agent');
  _orchestratorId = orch.id;
});

afterAll(() => {
  _resetMasterKeyCacheForTests();
  _testDb = null;
  vi.restoreAllMocks();
});

// ─── Helper: reset the entity's ROOT config between tests ─────────────────────

async function clearRootConfig() {
  if (!_testDb) throw new Error('DB not initialised');
  await _testDb
    .update(entities)
    .set({ rootAgentId: null, rootGrants: {} })
    .where(eq(entities.id, _testEntityId));
  await _testDb
    .delete(approvalRules)
    .where(
      and(
        eq(approvalRules.entityId, _testEntityId),
        inArray(approvalRules.toolName, META_TOOL_NAMES as unknown as string[]),
      ),
    );
}

// ─── getRootConfigAction ──────────────────────────────────────────────────────

describe('getRootConfigAction', () => {
  it('returns rootAgentId=null and DEFAULT_ROOT_GRANTS when nothing has been set', async () => {
    await clearRootConfig();
    const { getRootConfigAction } = await import('../src/lib/actions.ts');
    const { DEFAULT_ROOT_GRANTS } = await import('@nodal-agents/shared');
    const res = await getRootConfigAction();
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.rootAgentId).toBeNull();
    expect(res.data.grants).toEqual(DEFAULT_ROOT_GRANTS);
  });
});

// ─── setRootAgentAction — validation failures ─────────────────────────────────

describe('setRootAgentAction — validation', () => {
  it('rejects non-guid rootAgentId', async () => {
    const { setRootAgentAction } = await import('../src/lib/actions.ts');
    const res = await setRootAgentAction({
      rootAgentId: 'not-a-uuid',
      grants: {
        createAgent: true,
        createSkill: true,
        assignSkill: true,
        autonomy: 'propose_confirm',
      },
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe('validation_failed');
  });

  it('rejects invalid autonomy value', async () => {
    const { setRootAgentAction } = await import('../src/lib/actions.ts');
    const res = await setRootAgentAction({
      rootAgentId: null,
      grants: { createAgent: true, createSkill: true, assignSkill: true, autonomy: 'turbo_mode' },
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe('validation_failed');
  });

  it('rejects a worker agent as ROOT', async () => {
    const { setRootAgentAction } = await import('../src/lib/actions.ts');
    const res = await setRootAgentAction({
      rootAgentId: _workerAgentId,
      grants: {
        createAgent: true,
        createSkill: true,
        assignSkill: true,
        autonomy: 'propose_confirm',
      },
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.code).toBe('validation_failed');
      expect(res.message).toContain('orchestrator');
    }
  });

  it('does NOT write entity row when validation fails (non-orchestrator agent)', async () => {
    await clearRootConfig();
    const { setRootAgentAction } = await import('../src/lib/actions.ts');
    await setRootAgentAction({
      rootAgentId: _workerAgentId,
      grants: {
        createAgent: true,
        createSkill: true,
        assignSkill: true,
        autonomy: 'propose_confirm',
      },
    });
    // Entity rootAgentId must still be null
    const [row] = await _testDb!
      .select({ rootAgentId: entities.rootAgentId })
      .from(entities)
      .where(eq(entities.id, _testEntityId));
    expect(row?.rootAgentId).toBeNull();
  });
});

// ─── setRootAgentAction — happy paths ─────────────────────────────────────────

describe('setRootAgentAction — write paths', () => {
  it('sets a valid orchestrator as ROOT and writes entities row', async () => {
    await clearRootConfig();
    const { setRootAgentAction } = await import('../src/lib/actions.ts');
    const res = await setRootAgentAction({
      rootAgentId: _orchestratorId,
      grants: {
        createAgent: true,
        createSkill: true,
        assignSkill: true,
        autonomy: 'propose_confirm',
      },
    });
    expect(res.ok).toBe(true);

    // Assert real entity row
    const [row] = await _testDb!
      .select({ rootAgentId: entities.rootAgentId, rootGrants: entities.rootGrants })
      .from(entities)
      .where(eq(entities.id, _testEntityId));
    expect(row?.rootAgentId).toBe(_orchestratorId);
    const grants = row?.rootGrants as Record<string, unknown>;
    expect(grants?.['createAgent']).toBe(true);
    expect(grants?.['createSkill']).toBe(true);
    expect(grants?.['assignSkill']).toBe(true);
    expect(grants?.['autonomy']).toBe('propose_confirm');
  });

  it('propose_confirm: inserts require_approval rules for all enabled meta-tools', async () => {
    await clearRootConfig();
    const { setRootAgentAction } = await import('../src/lib/actions.ts');
    await setRootAgentAction({
      rootAgentId: _orchestratorId,
      grants: {
        createAgent: true,
        createSkill: true,
        assignSkill: true,
        autonomy: 'propose_confirm',
      },
    });

    // Assert actual approval_rules rows — NOT pre-seeded, created by the action.
    const rules = await _testDb!
      .select({
        agentId: approvalRules.agentId,
        toolName: approvalRules.toolName,
        action: approvalRules.action,
      })
      .from(approvalRules)
      .where(
        and(
          eq(approvalRules.entityId, _testEntityId),
          inArray(approvalRules.toolName, META_TOOL_NAMES as unknown as string[]),
        ),
      );

    expect(rules.length).toBe(3);
    const toolNames = rules.map((r) => r.toolName).sort();
    expect(toolNames).toEqual(['attach_skill', 'create_agent', 'create_skill']);
    for (const rule of rules) {
      expect(rule.agentId).toBe(_orchestratorId);
      expect(rule.action).toBe('require_approval');
    }
  });

  it('propose_confirm with only createAgent=true: only 1 rule inserted', async () => {
    await clearRootConfig();
    const { setRootAgentAction } = await import('../src/lib/actions.ts');
    await setRootAgentAction({
      rootAgentId: _orchestratorId,
      grants: {
        createAgent: true,
        createSkill: false,
        assignSkill: false,
        autonomy: 'propose_confirm',
      },
    });

    const rules = await _testDb!
      .select({ toolName: approvalRules.toolName })
      .from(approvalRules)
      .where(
        and(
          eq(approvalRules.entityId, _testEntityId),
          inArray(approvalRules.toolName, META_TOOL_NAMES as unknown as string[]),
        ),
      );

    expect(rules.length).toBe(1);
    expect(rules[0]?.toolName).toBe('create_agent');
  });

  it('fully_autonomous: no approval_rules rows inserted', async () => {
    await clearRootConfig();
    const { setRootAgentAction } = await import('../src/lib/actions.ts');
    await setRootAgentAction({
      rootAgentId: _orchestratorId,
      grants: {
        createAgent: true,
        createSkill: true,
        assignSkill: true,
        autonomy: 'fully_autonomous',
      },
    });

    const rules = await _testDb!
      .select({ id: approvalRules.id })
      .from(approvalRules)
      .where(
        and(
          eq(approvalRules.entityId, _testEntityId),
          inArray(approvalRules.toolName, META_TOOL_NAMES as unknown as string[]),
        ),
      );

    expect(rules.length).toBe(0);
  });

  it('destructive_gate: no approval_rules rows inserted (no destructive meta-tools in MVT)', async () => {
    await clearRootConfig();
    const { setRootAgentAction } = await import('../src/lib/actions.ts');
    await setRootAgentAction({
      rootAgentId: _orchestratorId,
      grants: {
        createAgent: true,
        createSkill: true,
        assignSkill: true,
        autonomy: 'destructive_gate',
      },
    });

    const rules = await _testDb!
      .select({ id: approvalRules.id })
      .from(approvalRules)
      .where(
        and(
          eq(approvalRules.entityId, _testEntityId),
          inArray(approvalRules.toolName, META_TOOL_NAMES as unknown as string[]),
        ),
      );

    expect(rules.length).toBe(0);
  });

  it('switching from propose_confirm to fully_autonomous deletes existing rules', async () => {
    await clearRootConfig();
    const { setRootAgentAction } = await import('../src/lib/actions.ts');

    // First: set propose_confirm → should have 3 rules
    await setRootAgentAction({
      rootAgentId: _orchestratorId,
      grants: {
        createAgent: true,
        createSkill: true,
        assignSkill: true,
        autonomy: 'propose_confirm',
      },
    });
    const rulesAfterFirst = await _testDb!
      .select({ id: approvalRules.id })
      .from(approvalRules)
      .where(
        and(
          eq(approvalRules.entityId, _testEntityId),
          inArray(approvalRules.toolName, META_TOOL_NAMES as unknown as string[]),
        ),
      );
    expect(rulesAfterFirst.length).toBe(3);

    // Second: switch to fully_autonomous → rules must be cleared
    await setRootAgentAction({
      rootAgentId: _orchestratorId,
      grants: {
        createAgent: true,
        createSkill: true,
        assignSkill: true,
        autonomy: 'fully_autonomous',
      },
    });
    const rulesAfterSwitch = await _testDb!
      .select({ id: approvalRules.id })
      .from(approvalRules)
      .where(
        and(
          eq(approvalRules.entityId, _testEntityId),
          inArray(approvalRules.toolName, META_TOOL_NAMES as unknown as string[]),
        ),
      );
    expect(rulesAfterSwitch.length).toBe(0);
  });

  it('unsets ROOT (rootAgentId=null): clears entity row and removes all meta-tool rules', async () => {
    await clearRootConfig();
    const { setRootAgentAction } = await import('../src/lib/actions.ts');

    // First set a root agent
    await setRootAgentAction({
      rootAgentId: _orchestratorId,
      grants: {
        createAgent: true,
        createSkill: true,
        assignSkill: true,
        autonomy: 'propose_confirm',
      },
    });

    // Then unset it
    const res = await setRootAgentAction({
      rootAgentId: null,
      grants: {
        createAgent: true,
        createSkill: true,
        assignSkill: true,
        autonomy: 'propose_confirm',
      },
    });
    expect(res.ok).toBe(true);

    // Entity row must have null rootAgentId
    const [row] = await _testDb!
      .select({ rootAgentId: entities.rootAgentId })
      .from(entities)
      .where(eq(entities.id, _testEntityId));
    expect(row?.rootAgentId).toBeNull();

    // Meta-tool rules must be cleared
    const rules = await _testDb!
      .select({ id: approvalRules.id })
      .from(approvalRules)
      .where(
        and(
          eq(approvalRules.entityId, _testEntityId),
          inArray(approvalRules.toolName, META_TOOL_NAMES as unknown as string[]),
        ),
      );
    expect(rules.length).toBe(0);
  });
});
