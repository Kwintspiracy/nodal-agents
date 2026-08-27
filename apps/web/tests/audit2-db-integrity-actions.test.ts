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

// ─── setCodeTaskYoloAction — mirrors setRunCommandYoloAction's R2 guarantee ───

describe('setCodeTaskYoloAction — re-toggle never leaves a duplicate row', () => {
  it('enable, then enable again (re-toggle race) leaves exactly ONE auto_approve row', async () => {
    const agentId = await makeAgent('Audit2 CodeTask Yolo Agent');
    const { setCodeTaskYoloAction } = await import('../src/lib/actions.ts');

    const first = await setCodeTaskYoloAction({ agentId, enabled: true });
    expect(first.ok).toBe(true);
    const second = await setCodeTaskYoloAction({ agentId, enabled: true });
    expect(second.ok).toBe(true);

    const rows = await _testDb!
      .select({ action: approvalRules.action })
      .from(approvalRules)
      .where(
        and(
          eq(approvalRules.entityId, _testEntityId),
          eq(approvalRules.agentId, agentId),
          eq(approvalRules.toolName, 'code_task'),
        ),
      );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.action).toBe('auto_approve');
  });

  it('disable removes the row', async () => {
    const agentId = await makeAgent('Audit2 CodeTask Yolo Agent Off');
    const { setCodeTaskYoloAction } = await import('../src/lib/actions.ts');

    await setCodeTaskYoloAction({ agentId, enabled: true });
    const off = await setCodeTaskYoloAction({ agentId, enabled: false });
    expect(off.ok).toBe(true);

    const rows = await _testDb!
      .select({ action: approvalRules.action })
      .from(approvalRules)
      .where(
        and(
          eq(approvalRules.entityId, _testEntityId),
          eq(approvalRules.agentId, agentId),
          eq(approvalRules.toolName, 'code_task'),
        ),
      );
    expect(rows).toHaveLength(0);
  });

  it('does not touch a run_command rule on the same agent (distinct tool_name rows)', async () => {
    const agentId = await makeAgent('Audit2 CodeTask And RunCommand Agent');
    const { setRunCommandYoloAction, setCodeTaskYoloAction } =
      await import('../src/lib/actions.ts');

    await setRunCommandYoloAction({ agentId, enabled: true });
    await setCodeTaskYoloAction({ agentId, enabled: true });

    const rows = await _testDb!
      .select({ toolName: approvalRules.toolName, action: approvalRules.action })
      .from(approvalRules)
      .where(and(eq(approvalRules.entityId, _testEntityId), eq(approvalRules.agentId, agentId)));

    const toolNames = rows.map((r) => r.toolName).sort();
    expect(toolNames).toEqual(['code_task', 'run_command']);
    expect(rows.every((r) => r.action === 'auto_approve')).toBe(true);
  });
});

// ─── setCliDefaultsAction — merge/clear semantics on agents.cli_defaults ─────

describe('setCliDefaultsAction — merges per-provider, empty state collapses to NULL', () => {
  it('sets model and effort for one provider', async () => {
    const agentId = await makeAgent('Audit2 CliDefaults Agent');
    const { setCliDefaultsAction } = await import('../src/lib/actions.ts');

    const result = await setCliDefaultsAction({
      agentId,
      provider: 'claude',
      model: 'claude-opus-5',
      effort: 'high',
    });
    expect(result.ok).toBe(true);

    const [row] = await _testDb!
      .select({ cliDefaults: agents.cliDefaults })
      .from(agents)
      .where(eq(agents.id, agentId));
    expect(row?.cliDefaults).toEqual({ claude: { model: 'claude-opus-5', effort: 'high' } });
  });

  it('setting the second provider does not clobber the first', async () => {
    const agentId = await makeAgent('Audit2 CliDefaults Both Agent');
    const { setCliDefaultsAction } = await import('../src/lib/actions.ts');

    await setCliDefaultsAction({
      agentId,
      provider: 'claude',
      model: 'claude-opus-5',
      effort: null,
    });
    await setCliDefaultsAction({
      agentId,
      provider: 'codex',
      model: 'gpt-5-codex',
      effort: 'medium',
    });

    const [row] = await _testDb!
      .select({ cliDefaults: agents.cliDefaults })
      .from(agents)
      .where(eq(agents.id, agentId));
    expect(row?.cliDefaults).toEqual({
      claude: { model: 'claude-opus-5' },
      codex: { model: 'gpt-5-codex', effort: 'medium' },
    });
  });

  it('clearing the only provider entry collapses cli_defaults to NULL, not {}', async () => {
    const agentId = await makeAgent('Audit2 CliDefaults Clear Agent');
    const { setCliDefaultsAction } = await import('../src/lib/actions.ts');

    await setCliDefaultsAction({
      agentId,
      provider: 'claude',
      model: 'claude-opus-5',
      effort: 'high',
    });
    const cleared = await setCliDefaultsAction({
      agentId,
      provider: 'claude',
      model: null,
      effort: null,
    });
    expect(cleared.ok).toBe(true);

    const [row] = await _testDb!
      .select({ cliDefaults: agents.cliDefaults })
      .from(agents)
      .where(eq(agents.id, agentId));
    expect(row?.cliDefaults).toBeNull();
  });

  it('rejects a model value outside the allowed charset', async () => {
    const agentId = await makeAgent('Audit2 CliDefaults Invalid Agent');
    const { setCliDefaultsAction } = await import('../src/lib/actions.ts');

    const result = await setCliDefaultsAction({
      agentId,
      provider: 'claude',
      model: 'not a valid model!',
      effort: null,
    });
    expect(result.ok).toBe(false);
  });
});

// ─── setCliProviderEnabledAction — owner allow-flag per coding-CLI provider ──

describe('setCliProviderEnabledAction — per-provider allow-flag on cli_defaults', () => {
  it('disabling stores enabled:false; re-enabling collapses back to NULL', async () => {
    const agentId = await makeAgent('Audit2 CliEnabled Agent');
    const { setCliProviderEnabledAction } = await import('../src/lib/actions.ts');

    const off = await setCliProviderEnabledAction({ agentId, provider: 'codex', enabled: false });
    expect(off.ok).toBe(true);
    let [row] = await _testDb!
      .select({ cliDefaults: agents.cliDefaults })
      .from(agents)
      .where(eq(agents.id, agentId));
    expect(row?.cliDefaults).toEqual({ codex: { enabled: false } });

    const on = await setCliProviderEnabledAction({ agentId, provider: 'codex', enabled: true });
    expect(on.ok).toBe(true);
    [row] = await _testDb!
      .select({ cliDefaults: agents.cliDefaults })
      .from(agents)
      .where(eq(agents.id, agentId));
    // true = absent: back to the pre-feature NULL, not `{codex:{enabled:true}}`.
    expect(row?.cliDefaults).toBeNull();
  });

  it('REFUSES disabling the last enabled provider', async () => {
    const agentId = await makeAgent('Audit2 CliEnabled Last Agent');
    const { setCliProviderEnabledAction } = await import('../src/lib/actions.ts');

    await setCliProviderEnabledAction({ agentId, provider: 'claude', enabled: false });
    const result = await setCliProviderEnabledAction({
      agentId,
      provider: 'codex',
      enabled: false,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain('At least one');

    const [row] = await _testDb!
      .select({ cliDefaults: agents.cliDefaults })
      .from(agents)
      .where(eq(agents.id, agentId));
    // codex untouched — only claude carries the flag.
    expect(row?.cliDefaults).toEqual({ claude: { enabled: false } });
  });

  it('saving model/effort defaults PRESERVES a stored enabled:false', async () => {
    const agentId = await makeAgent('Audit2 CliEnabled Preserve Agent');
    const { setCliProviderEnabledAction, setCliDefaultsAction } =
      await import('../src/lib/actions.ts');

    await setCliProviderEnabledAction({ agentId, provider: 'claude', enabled: false });
    await setCliDefaultsAction({ agentId, provider: 'claude', model: 'opus', effort: 'high' });

    const [row] = await _testDb!
      .select({ cliDefaults: agents.cliDefaults })
      .from(agents)
      .where(eq(agents.id, agentId));
    expect(row?.cliDefaults).toEqual({
      claude: { model: 'opus', effort: 'high', enabled: false },
    });
  });
});

// ─── setReviewerReadOnlyPresetAction — bulk block, delete-only-block on off ───

const READONLY_PRESET_TOOLS = [
  'file_write',
  'file_edit',
  'skill_file_write',
  'run_command',
  'run_skill_script',
];

describe('setReviewerReadOnlyPresetAction', () => {
  it('enable sets a block row on all 5 preset tools', async () => {
    const agentId = await makeAgent('Audit2 ReadOnly Agent');
    const { setReviewerReadOnlyPresetAction } = await import('../src/lib/actions.ts');

    const result = await setReviewerReadOnlyPresetAction({ agentId, enabled: true });
    expect(result.ok).toBe(true);

    const rows = await _testDb!
      .select({ toolName: approvalRules.toolName, action: approvalRules.action })
      .from(approvalRules)
      .where(and(eq(approvalRules.entityId, _testEntityId), eq(approvalRules.agentId, agentId)));

    expect(rows.map((r) => r.toolName).sort()).toEqual([...READONLY_PRESET_TOOLS].sort());
    expect(rows.every((r) => r.action === 'block')).toBe(true);
  });

  it('enable is idempotent — calling it twice still leaves exactly 5 rows', async () => {
    const agentId = await makeAgent('Audit2 ReadOnly Idempotent Agent');
    const { setReviewerReadOnlyPresetAction } = await import('../src/lib/actions.ts');

    await setReviewerReadOnlyPresetAction({ agentId, enabled: true });
    const second = await setReviewerReadOnlyPresetAction({ agentId, enabled: true });
    expect(second.ok).toBe(true);

    const rows = await _testDb!
      .select({ toolName: approvalRules.toolName, action: approvalRules.action })
      .from(approvalRules)
      .where(and(eq(approvalRules.entityId, _testEntityId), eq(approvalRules.agentId, agentId)));

    expect(rows).toHaveLength(READONLY_PRESET_TOOLS.length);
    expect(rows.every((r) => r.action === 'block')).toBe(true);
  });

  it('disable removes only the block rows, a require_approval rule set by hand survives', async () => {
    const agentId = await makeAgent('Audit2 ReadOnly Disable Agent');
    const { setReviewerReadOnlyPresetAction, setAgentApprovalRuleAction } =
      await import('../src/lib/actions.ts');

    await setReviewerReadOnlyPresetAction({ agentId, enabled: true });
    // A rule the user set by hand, on one of the same 5 tools, but a
    // DIFFERENT action — must not be treated as "part of the preset".
    await setAgentApprovalRuleAction({
      agentId,
      toolName: 'run_command',
      action: 'require_approval',
    });

    const disable = await setReviewerReadOnlyPresetAction({ agentId, enabled: false });
    expect(disable.ok).toBe(true);

    const rows = await _testDb!
      .select({ toolName: approvalRules.toolName, action: approvalRules.action })
      .from(approvalRules)
      .where(and(eq(approvalRules.entityId, _testEntityId), eq(approvalRules.agentId, agentId)));

    expect(rows).toHaveLength(1);
    expect(rows[0]?.toolName).toBe('run_command');
    expect(rows[0]?.action).toBe('require_approval');
  });

  it('disable on an agent with no rules is a harmless no-op', async () => {
    const agentId = await makeAgent('Audit2 ReadOnly Never Enabled Agent');
    const { setReviewerReadOnlyPresetAction } = await import('../src/lib/actions.ts');

    const result = await setReviewerReadOnlyPresetAction({ agentId, enabled: false });
    expect(result.ok).toBe(true);

    const rows = await _testDb!
      .select({ toolName: approvalRules.toolName })
      .from(approvalRules)
      .where(and(eq(approvalRules.entityId, _testEntityId), eq(approvalRules.agentId, agentId)));
    expect(rows).toHaveLength(0);
  });
});

// ─── setAgentRuntimeAction — pose/repose le runtime, liste FERMÉE ────────────

describe('setAgentRuntimeAction', () => {
  it('sets runtime to claude-code, then back to nodal', async () => {
    const agentId = await makeAgent('Audit2 Runtime Agent');
    const { setAgentRuntimeAction } = await import('../src/lib/actions.ts');

    const toClaudeCode = await setAgentRuntimeAction({ agentId, runtime: 'claude-code' });
    expect(toClaudeCode.ok).toBe(true);

    const [afterSwitch] = await _testDb!
      .select({ runtime: agents.runtime })
      .from(agents)
      .where(eq(agents.id, agentId));
    expect(afterSwitch?.runtime).toBe('claude-code');

    const backToNodal = await setAgentRuntimeAction({ agentId, runtime: 'nodal' });
    expect(backToNodal.ok).toBe(true);

    const [afterRevert] = await _testDb!
      .select({ runtime: agents.runtime })
      .from(agents)
      .where(eq(agents.id, agentId));
    expect(afterRevert?.runtime).toBe('nodal');
  });

  it('accepte "codex" — le siège réservé est ouvert depuis le 27/08', async () => {
    // Ce test assertait l'inverse pendant huit jours : la contrainte SQL
    // acceptait `codex`, ce Zod le refusait, et le runner échouait fort dessus.
    // L'ouverture est venue avec son module de tour
    // (apps/runner/src/cli-runtime/codex-turn.ts) ; sans lui, accepter ici
    // aurait donné un agent qu'on peut choisir et qui plante à chaque tour.
    const agentId = await makeAgent('Audit2 Runtime Codex Agent');
    const { setAgentRuntimeAction } = await import('../src/lib/actions.ts');

    const result = await setAgentRuntimeAction({ agentId, runtime: 'codex' });
    expect(result.ok, 'le runtime Codex reste refusé par la validation').toBe(true);

    const [row] = await _testDb!
      .select({ runtime: agents.runtime })
      .from(agents)
      .where(eq(agents.id, agentId));
    expect(row?.runtime).toBe('codex');
  });

  it('un runtime INCONNU reste refusé — la liste est fermée', async () => {
    // Le pendant du test ci-dessus : ouvrir Codex ne doit pas ouvrir la porte à
    // n'importe quelle chaîne. La contrainte SQL la refuserait de toute façon,
    // mais en erreur de base plutôt qu'en message de validation.
    const agentId = await makeAgent('Audit2 Runtime Unknown Agent');
    const { setAgentRuntimeAction } = await import('../src/lib/actions.ts');

    const result = await setAgentRuntimeAction({ agentId, runtime: 'gemini-cli' });
    expect(result.ok).toBe(false);

    const [row] = await _testDb!
      .select({ runtime: agents.runtime })
      .from(agents)
      .where(eq(agents.id, agentId));
    expect(row?.runtime).toBe('nodal');
  });
});

// ─── setCliRuntimeModeAction — merges mode, never erases extraDisallowed ──────

describe('setCliRuntimeModeAction', () => {
  it('merges mode onto existing cli_permissions without touching extraDisallowed', async () => {
    const agentId = await makeAgent('Audit2 Runtime Mode Agent');
    // Seed a pre-existing permission shape the action must preserve untouched.
    await _testDb!
      .update(agents)
      .set({ cliPermissions: { mode: 'read', extraDisallowed: ['WebSearch'] } })
      .where(eq(agents.id, agentId));

    const { setCliRuntimeModeAction } = await import('../src/lib/actions.ts');
    const result = await setCliRuntimeModeAction({ agentId, mode: 'write' });
    expect(result.ok).toBe(true);

    const [row] = await _testDb!
      .select({ cliPermissions: agents.cliPermissions })
      .from(agents)
      .where(eq(agents.id, agentId));
    expect(row?.cliPermissions).toEqual({ mode: 'write', extraDisallowed: ['WebSearch'] });
  });

  it('sets mode on an agent with no prior cli_permissions row', async () => {
    const agentId = await makeAgent('Audit2 Runtime Mode Fresh Agent');
    const { setCliRuntimeModeAction } = await import('../src/lib/actions.ts');

    const result = await setCliRuntimeModeAction({ agentId, mode: 'write' });
    expect(result.ok).toBe(true);

    const [row] = await _testDb!
      .select({ cliPermissions: agents.cliPermissions })
      .from(agents)
      .where(eq(agents.id, agentId));
    expect(row?.cliPermissions).toEqual({ mode: 'write' });
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
