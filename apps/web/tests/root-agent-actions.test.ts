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
import type * as NodalMemory from '@nodal-agents/memory';

// ─── Module-level state ───────────────────────────────────────────────────────

let _testDb: TestDb | null = null;
let _testUserId = 'placeholder-user-id';
let _testEntityId = 'placeholder-entity-id';
// Seeded orchestrator agent id — set in beforeAll after seeding.
let _orchestratorId = 'placeholder-orchestrator-id';

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

// cli-config touches the filesystem — stub it out.
vi.mock('../src/lib/cli-config.ts', () => ({
  NODALAI_CONFIG_PATH: '/tmp/test/config.json',
  readNodalaiConfig: vi.fn(),
  mergeNodalaiConfig: vi.fn(),
}));

// memory package has its own complex chain — stub the public API directly.
vi.mock('@nodal-agents/memory', async () => {
  const actual = await vi.importActual<typeof NodalMemory>('@nodal-agents/memory');
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

// ─── Helpers: set/clear the entity's ROOT between tests ───────────────────────
// Brique F: the ROOT is the entity's origin orchestrator, designated
// automatically (createAgentRepo). setRootAgentAction only TUNES its grants —
// it no longer picks the agent. So these helpers stand in for what
// createAgentRepo would have done: point the entity at our seeded orchestrator
// (or leave it without a ROOT), then exercise the grants-only action.

//
// `mayChangeTeam` (issue #137) is part of the state a test runs in: the rules
// synced by setRootAgentAction describe the tools the runner will ACTUALLY hand
// the ROOT, and the three team tools only reach it when this is on. It defaults
// to false here, which is what every install gets from migration 0111.
async function setRoot(orchId: string | null, mayChangeTeam = false) {
  if (!_testDb) throw new Error('DB not initialised');
  await _testDb
    .update(entities)
    .set({ rootAgentId: orchId, rootGrants: {} })
    .where(eq(entities.id, _testEntityId));
  if (orchId) {
    await _testDb.update(agents).set({ mayChangeTeam }).where(eq(agents.id, orchId));
  }
  await _testDb
    .delete(approvalRules)
    .where(
      and(
        eq(approvalRules.entityId, _testEntityId),
        inArray(approvalRules.toolName, META_TOOL_NAMES as unknown as string[]),
      ),
    );
}

const ALL_ON = {
  createAgent: true,
  updateAgent: true,
  attachAgent: true,
  createSkill: true,
  updateSkill: true,
  assignSkill: true,
  createMcp: true,
  attachMcp: true,
  createConnector: true,
  attachConnector: true,
  manageSchedules: true,
} as const;

async function metaRules() {
  return _testDb!
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
}

// ─── getRootConfigAction ──────────────────────────────────────────────────────

describe('getRootConfigAction', () => {
  it('returns rootAgentId=null and DEFAULT_ROOT_GRANTS when nothing has been set', async () => {
    await setRoot(null);
    const { getRootConfigAction } = await import('../src/lib/actions.ts');
    const { DEFAULT_ROOT_GRANTS } = await import('@nodal-agents/shared');
    const res = await getRootConfigAction();
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.rootAgentId).toBeNull();
    // Empty stored grants parse to the original defaults, EXCEPT the newer
    // opt-in grants: createMcp/createConnector absent → false (never granted
    // retroactively), their attach_* mirrors inherit that false, and
    // manageSchedules (a new capability) is also opt-in-false.
    expect(res.data.grants).toEqual({
      ...DEFAULT_ROOT_GRANTS,
      createMcp: false,
      attachMcp: false,
      createConnector: false,
      attachConnector: false,
      manageSchedules: false,
    });
  });

  it('reflects the auto-designated ROOT once one exists', async () => {
    await setRoot(_orchestratorId);
    const { getRootConfigAction } = await import('../src/lib/actions.ts');
    const res = await getRootConfigAction();
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.rootAgentId).toBe(_orchestratorId);
  });
});

// ─── setRootAgentAction — validation / preconditions ──────────────────────────

describe('setRootAgentAction — validation', () => {
  it('rejects invalid autonomy value', async () => {
    await setRoot(_orchestratorId);
    const { setRootAgentAction } = await import('../src/lib/actions.ts');
    const res = await setRootAgentAction({
      grants: { ...ALL_ON, autonomy: 'turbo_mode' },
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe('validation_failed');
  });

  it('returns not_found when no ROOT has been designated yet', async () => {
    await setRoot(null);
    const { setRootAgentAction } = await import('../src/lib/actions.ts');
    const res = await setRootAgentAction({
      grants: { ...ALL_ON, autonomy: 'propose_confirm' },
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe('not_found');
  });

  it('writes nothing when there is no ROOT (rootGrants stays empty)', async () => {
    await setRoot(null);
    const { setRootAgentAction } = await import('../src/lib/actions.ts');
    await setRootAgentAction({ grants: { ...ALL_ON, autonomy: 'propose_confirm' } });
    const [row] = await _testDb!
      .select({ rootAgentId: entities.rootAgentId })
      .from(entities)
      .where(eq(entities.id, _testEntityId));
    expect(row?.rootAgentId).toBeNull();
    expect((await metaRules()).length).toBe(0);
  });
});

// ─── setRootAgentAction — write paths ─────────────────────────────────────────

describe('setRootAgentAction — write paths', () => {
  it('tunes grants on the existing ROOT and leaves rootAgentId untouched', async () => {
    await setRoot(_orchestratorId);
    const { setRootAgentAction } = await import('../src/lib/actions.ts');
    const res = await setRootAgentAction({
      grants: { ...ALL_ON, autonomy: 'propose_confirm' },
    });
    expect(res.ok).toBe(true);

    const [row] = await _testDb!
      .select({ rootAgentId: entities.rootAgentId, rootGrants: entities.rootGrants })
      .from(entities)
      .where(eq(entities.id, _testEntityId));
    // The ROOT itself is structural — the action must not change it.
    expect(row?.rootAgentId).toBe(_orchestratorId);
    const grants = row?.rootGrants as Record<string, unknown>;
    expect(grants?.['createAgent']).toBe(true);
    expect(grants?.['createSkill']).toBe(true);
    expect(grants?.['assignSkill']).toBe(true);
    expect(grants?.['autonomy']).toBe('propose_confirm');
  });

  it('propose_confirm: inserts require_approval rules for all enabled meta-tools', async () => {
    // The ROOT may change its team here, so the full granted list applies —
    // this test is about the autonomy level, not about the team gate, which
    // has its own describe below.
    await setRoot(_orchestratorId, true);
    const { setRootAgentAction } = await import('../src/lib/actions.ts');
    await setRootAgentAction({ grants: { ...ALL_ON, autonomy: 'propose_confirm' } });

    const rules = await metaRules();
    const toolNames = rules.map((r) => r.toolName).sort();
    // ALL_ON enables every meta-tool; attach grants also enable their detach
    // mirror and manageSchedules enables the cron CRUD. Compute the expected set
    // from the source of truth so it stays correct as the grant map evolves.
    const { enabledMetaTools } = await import('@nodal-agents/shared');
    const expectedNames = enabledMetaTools({ ...ALL_ON, autonomy: 'propose_confirm' }).sort();
    expect(toolNames).toEqual(expectedNames);
    for (const rule of rules) {
      expect(rule.agentId).toBe(_orchestratorId);
      expect(rule.action).toBe('require_approval');
    }
  });

  it('propose_confirm with only createAgent=true: only 1 rule inserted', async () => {
    await setRoot(_orchestratorId, true);
    const { setRootAgentAction } = await import('../src/lib/actions.ts');
    await setRootAgentAction({
      grants: {
        createAgent: true,
        updateAgent: false,
        attachAgent: false,
        createSkill: false,
        updateSkill: false,
        assignSkill: false,
        createMcp: false,
        attachMcp: false,
        createConnector: false,
        attachConnector: false,
        manageSchedules: false,
        autonomy: 'propose_confirm',
      },
    });
    const rules = await metaRules();
    expect(rules.length).toBe(1);
    expect(rules[0]?.toolName).toBe('create_agent');
  });

  it('all grants off (opt-in default): no rules, ROOT preserved', async () => {
    await setRoot(_orchestratorId);
    const { setRootAgentAction } = await import('../src/lib/actions.ts');
    await setRootAgentAction({
      grants: {
        createAgent: false,
        attachAgent: false,
        createSkill: false,
        updateSkill: false,
        assignSkill: false,
        createMcp: false,
        createConnector: false,
        autonomy: 'propose_confirm',
      },
    });
    expect((await metaRules()).length).toBe(0);
    const [row] = await _testDb!
      .select({ rootAgentId: entities.rootAgentId })
      .from(entities)
      .where(eq(entities.id, _testEntityId));
    expect(row?.rootAgentId).toBe(_orchestratorId);
  });

  it('fully_autonomous: no approval_rules rows inserted', async () => {
    await setRoot(_orchestratorId);
    const { setRootAgentAction } = await import('../src/lib/actions.ts');
    await setRootAgentAction({ grants: { ...ALL_ON, autonomy: 'fully_autonomous' } });
    expect((await metaRules()).length).toBe(0);
  });

  it('destructive_gate: no approval_rules rows inserted (no destructive meta-tools in MVT)', async () => {
    await setRoot(_orchestratorId);
    const { setRootAgentAction } = await import('../src/lib/actions.ts');
    await setRootAgentAction({ grants: { ...ALL_ON, autonomy: 'destructive_gate' } });
    expect((await metaRules()).length).toBe(0);
  });

  it('switching from propose_confirm to fully_autonomous deletes existing rules', async () => {
    await setRoot(_orchestratorId, true);
    const { setRootAgentAction } = await import('../src/lib/actions.ts');

    const { enabledMetaTools } = await import('@nodal-agents/shared');
    const expectedCount = enabledMetaTools({ ...ALL_ON, autonomy: 'propose_confirm' }).length;
    await setRootAgentAction({ grants: { ...ALL_ON, autonomy: 'propose_confirm' } });
    expect((await metaRules()).length).toBe(expectedCount);

    await setRootAgentAction({ grants: { ...ALL_ON, autonomy: 'fully_autonomous' } });
    expect((await metaRules()).length).toBe(0);
  });

  it('re-syncing the same propose_confirm grants twice in a row leaves exactly ONE row per meta-tool — R2 (audit #2 follow-up)', async () => {
    // The delete-then-insert is now wrapped in db.transaction + onConflictDoUpdate
    // (approval_rules carries a UNIQUE(entity_id, agent_id, tool_name) constraint
    // since DB-1) — re-syncing must stay canonical, never duplicate a row per tool.
    await setRoot(_orchestratorId, true);
    const { setRootAgentAction } = await import('../src/lib/actions.ts');
    const grants = {
      createAgent: true,
      updateAgent: false,
      attachAgent: false,
      createSkill: false,
      updateSkill: false,
      assignSkill: false,
      createMcp: false,
      attachMcp: false,
      createConnector: false,
      attachConnector: false,
      manageSchedules: false,
      autonomy: 'propose_confirm' as const,
    };

    const first = await setRootAgentAction({ grants });
    expect(first.ok).toBe(true);
    const second = await setRootAgentAction({ grants });
    expect(second.ok).toBe(true);

    const rules = await metaRules();
    expect(rules).toHaveLength(1);
    expect(rules[0]?.toolName).toBe('create_agent');
    expect(rules[0]?.action).toBe('require_approval');
  });
});

// ─── The team gate and the approval rules agree (issue #137) ──────────────────
//
// The rules this action writes are read by the Autonomy tab and by the runner's
// approval gate. Syncing them from the workspace grants ALONE would write a
// `require_approval` row for a tool the runner never hands this agent: an
// approval nobody is ever asked for, and a line on screen for a power the agent
// does not have. The assertions are on the rows in `approval_rules`, not on
// what the action was called with.
describe('setRootAgentAction — approval rules follow "May change its own team"', () => {
  const TEAM_TOOLS = ['create_agent', 'attach_agent', 'detach_agent'];

  it('setting OFF: no rule for the three team tools, every other granted tool keeps its rule', async () => {
    await setRoot(_orchestratorId, false);
    const { setRootAgentAction } = await import('../src/lib/actions.ts');
    const res = await setRootAgentAction({ grants: { ...ALL_ON, autonomy: 'propose_confirm' } });
    expect(res.ok).toBe(true);

    const toolNames = (await metaRules()).map((r) => r.toolName).sort();
    for (const name of TEAM_TOOLS) {
      expect(toolNames, `${name} has an approval rule it can never use`).not.toContain(name);
    }
    // The gate removes the three and nothing else — computed from the source of
    // truth so it stays correct as the grant map evolves.
    const { metaToolsForAgent } = await import('@nodal-agents/shared');
    const expected = metaToolsForAgent(
      { ...ALL_ON, autonomy: 'propose_confirm' },
      { mayChangeTeam: false },
    ).sort();
    expect(toolNames).toEqual(expected);
    expect(toolNames).toContain('update_agent');
    expect(toolNames).toContain('attach_skill');
  });

  it('setting ON: the three team tools get their require_approval rule', async () => {
    await setRoot(_orchestratorId, true);
    const { setRootAgentAction } = await import('../src/lib/actions.ts');
    await setRootAgentAction({ grants: { ...ALL_ON, autonomy: 'propose_confirm' } });

    const rules = await metaRules();
    const toolNames = rules.map((r) => r.toolName);
    for (const name of TEAM_TOOLS) {
      expect(toolNames).toContain(name);
    }
    for (const rule of rules.filter((r) => TEAM_TOOLS.includes(r.toolName))) {
      expect(rule.agentId).toBe(_orchestratorId);
      expect(rule.action).toBe('require_approval');
    }
  });

  it('turning the setting back off clears the three rules on the next sync', async () => {
    const { setRootAgentAction } = await import('../src/lib/actions.ts');
    await setRoot(_orchestratorId, true);
    await setRootAgentAction({ grants: { ...ALL_ON, autonomy: 'propose_confirm' } });
    expect((await metaRules()).map((r) => r.toolName)).toContain('attach_agent');

    // Only the agent's own setting changes — the workspace grants are re-sent
    // exactly as they were.
    await _testDb!
      .update(agents)
      .set({ mayChangeTeam: false })
      .where(eq(agents.id, _orchestratorId));
    await setRootAgentAction({ grants: { ...ALL_ON, autonomy: 'propose_confirm' } });

    const toolNames = (await metaRules()).map((r) => r.toolName);
    for (const name of TEAM_TOOLS) {
      expect(toolNames).not.toContain(name);
    }
    expect(toolNames).toContain('create_skill');
  });
});
