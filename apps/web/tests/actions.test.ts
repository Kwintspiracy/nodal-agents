/**
 * Unit tests for src/lib/actions.ts
 *
 * Focus: validate the public contract of each Server Action:
 *   - Bad inputs → validation_failed
 *   - Missing records → not_found
 *   - Good inputs + mock DB → ok with correct shape
 *
 * The mock for server.ts replaces getDb() with a factory that returns
 * a minimal Drizzle-compatible chainable object.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { randomBytes } from 'node:crypto';
import {
  _setMasterKeyForTests,
  _resetMasterKeyCacheForTests,
  encrypt,
  decrypt,
  isEncrypted,
} from '@nodal-agents/secrets';
import { LOCAL_ENTITY_ID } from '@nodal-agents/auth';
import { systemSkillSlugs } from '@nodal-agents/catalog';

beforeAll(() => {
  process.env['DATABASE_URL'] = 'postgres://placeholder:5432/placeholder';
  process.env['AUTH_MODE'] = 'local-trust';
  process.env['RUNNER_URL'] = 'http://localhost:3001';
  process.env['WORKER_SECRET'] = 'test-bearer-789';
  // Inject a deterministic test master key so encrypt()/decrypt() in actions.ts
  // never touches the real ~/.nodalai/secrets.key (Brique 26).
  _setMasterKeyForTests(randomBytes(32));
});

afterAll(() => {
  _resetMasterKeyCacheForTests();
});

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

// ─── Minimal Drizzle chain mock ───────────────────────────────────────────────
// Drizzle builders are awaitable — they resolve on `.then()`.
// We create a factory that returns a chainable object where the final
// `.then()` resolves with a given array.

function chain(rows: unknown[]): unknown {
  const p = Promise.resolve(rows);
  const c: Record<string, unknown> = {
    then: (onFulfilled: (v: unknown) => unknown, onRejected: (e: unknown) => unknown) =>
      p.then(onFulfilled, onRejected),
    catch: (onRejected: (e: unknown) => unknown) => p.catch(onRejected),
    finally: (onFinally: () => unknown) => p.finally(onFinally),
  };
  // All chainable methods return the same object (the terminal is always awaited)
  for (const m of [
    'from',
    'where',
    'orderBy',
    'limit',
    'values',
    'returning',
    'set',
    'onConflictDoNothing',
    'onConflictDoUpdate',
    'leftJoin',
    'innerJoin',
    'rightJoin',
    'fullJoin',
    'groupBy',
    'having',
    'offset',
  ]) {
    c[m] = vi.fn().mockReturnValue(c);
  }
  return c;
}

function makeDb(rows: unknown[] = []) {
  const c = chain(rows);
  const db = {
    select: vi.fn().mockReturnValue(c),
    selectDistinct: vi.fn().mockReturnValue(c),
    insert: vi.fn().mockReturnValue(c),
    delete: vi.fn().mockReturnValue(c),
    update: vi.fn().mockReturnValue(c),
    // execute() is the raw-SQL escape hatch (e.g. WITH RECURSIVE in
    // cancelJobAction's cascade). Real Drizzle returns a Result with
    // rowCount; an empty-array resolved promise is enough for unit tests
    // that only care that execute was called.
    execute: vi.fn().mockResolvedValue([]),
    // transaction() (F-19, audit #2 — updateAgentAction's sub-agent rewrite):
    // the mock has no real atomicity to offer, so it just hands the callback
    // this same chainable db as `tx` — enough for tests that only assert on
    // the calls/values a real transaction's tx would have received.
    transaction: vi.fn((cb: (tx: unknown) => unknown) => cb(db)),
  };
  return db;
}

/**
 * Mock that returns DIFFERENT data for SELECT vs INSERT chains. Useful when
 * an action does a uniqueness check (SELECT empty = available) then writes
 * (INSERT returning {id}). The plain `makeDb(rows)` factory returns the same
 * `rows` for every chain, which conflates the two and fails one of them.
 */
function makeDbMixed(opts: { select?: unknown[]; insert?: unknown[]; update?: unknown[] }) {
  const db = {
    select: vi.fn().mockReturnValue(chain(opts.select ?? [])),
    selectDistinct: vi.fn().mockReturnValue(chain(opts.select ?? [])),
    insert: vi.fn().mockReturnValue(chain(opts.insert ?? [])),
    delete: vi.fn().mockReturnValue(chain([])),
    update: vi.fn().mockReturnValue(chain(opts.update ?? [])),
    execute: vi.fn().mockResolvedValue([]),
    transaction: vi.fn((cb: (tx: unknown) => unknown) => cb(db)),
  };
  return db;
}

/**
 * Serialize a Drizzle `where()` condition for assertions on which columns/values
 * it references. Real column objects carry a `table` back-reference (the table
 * that owns them), which JSON.stringify can't follow — so it's dropped here.
 */
function serializeSqlCondition(cond: unknown): string {
  return JSON.stringify(cond, (key, value) => (key === 'table' ? undefined : value));
}

// ─── Mock server.ts ───────────────────────────────────────────────────────────
let currentDb = makeDb([]);

vi.mock('../src/lib/server.ts', async () => {
  const { LocalTrustProvider } = await import('@nodal-agents/auth');
  const provider = new LocalTrustProvider();
  return {
    getDb: vi.fn(() => currentDb),
    getAuthProvider: vi.fn(() => provider),
    requireAuth: vi.fn(),
    requireAuthWithEntity: vi.fn(),
    requireUser: vi.fn(),
    requireUserWithEntity: vi.fn(),
    // Active-workspace override is a no-op in tests (no cookie): passthrough.
    applyActiveEntity: vi.fn(async (session: unknown) => session),
    ACTIVE_ENTITY_COOKIE: 'nodalai_active_entity',
  };
});

// ─── Mock @nodal-agents/memory ─────────────────────────────────────────────────────
// The memory package's chained queries don't fit our simple chainable mock
// (count + items in two distinct selects); we stub the public API directly.
const memoryMocks = {
  listMemories: vi.fn(),
  deleteMemory: vi.fn(),
  updateMemory: vi.fn(),
  createMemory: vi.fn(),
  keywordSearchMemories: vi.fn(),
};

vi.mock('@nodal-agents/memory', async () => {
  const actual =
    await vi.importActual<typeof import('@nodal-agents/memory')>('@nodal-agents/memory');
  return {
    ...actual,
    listMemories: (...args: unknown[]) => memoryMocks.listMemories(...args),
    deleteMemory: (...args: unknown[]) => memoryMocks.deleteMemory(...args),
    updateMemory: (...args: unknown[]) => memoryMocks.updateMemory(...args),
    createMemory: (...args: unknown[]) => memoryMocks.createMemory(...args),
    keywordSearchMemories: (...args: unknown[]) => memoryMocks.keywordSearchMemories(...args),
  };
});

// ─── Mock @nodal-agents/adapter-mcp ───────────────────────────────────────────
// createMcpServerFromCatalogAction connects to a live MCP server — stub the
// connect so tests run offline.
const mcpAdapterMocks = {
  connectMcp: vi.fn(),
};

vi.mock('@nodal-agents/adapter-mcp', () => ({
  connectMcp: (...args: unknown[]) => mcpAdapterMocks.connectMcp(...args),
}));

// ─── Mock cli-config (filesystem access) ─────────────────────────────────────
const cliConfigMocks: {
  read: ReturnType<typeof vi.fn>;
  merge: ReturnType<typeof vi.fn>;
} = {
  read: vi.fn(),
  merge: vi.fn(),
};

vi.mock('../src/lib/cli-config.ts', () => ({
  NODALAI_CONFIG_PATH: '/tmp/test/config.json',
  readNodalaiConfig: () => cliConfigMocks.read(),
  mergeNodalaiConfig: (patch: unknown) => cliConfigMocks.merge(patch),
}));

// ─── Validation tests (no DB needed) ─────────────────────────────────────────

describe('createAgentAction — validation', () => {
  it('rejects slug with uppercase letters', async () => {
    const { createAgentAction } = await import('../src/lib/actions.ts');
    const r = await createAgentAction({ slug: 'UPPER', name: 'X', personality: 'Y' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('validation_failed');
  });

  it('rejects slug with spaces', async () => {
    const { createAgentAction } = await import('../src/lib/actions.ts');
    const r = await createAgentAction({ slug: 'my agent', name: 'X', personality: 'Y' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('validation_failed');
  });

  it('rejects empty name', async () => {
    const { createAgentAction } = await import('../src/lib/actions.ts');
    const r = await createAgentAction({ slug: 'valid', name: '', personality: 'Y' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('validation_failed');
  });

  it('rejects missing personality', async () => {
    const { createAgentAction } = await import('../src/lib/actions.ts');
    const r = await createAgentAction({ slug: 'valid', name: 'Valid' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('validation_failed');
  });
});

describe('deleteAgentAction — validation', () => {
  it('rejects non-uuid id', async () => {
    const { deleteAgentAction } = await import('../src/lib/actions.ts');
    const r = await deleteAgentAction('not-uuid');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('validation_failed');
  });
});

describe('sendTaskAction — validation', () => {
  it('rejects non-uuid agentId', async () => {
    const { sendTaskAction } = await import('../src/lib/actions.ts');
    const r = await sendTaskAction({ prompt: 'Do X', agentId: 'bad' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('validation_failed');
  });

  it('rejects empty prompt', async () => {
    const { sendTaskAction } = await import('../src/lib/actions.ts');
    const r = await sendTaskAction({ prompt: '', agentId: 'aaaaaaaa-0000-0000-0000-000000000001' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('validation_failed');
  });

  it('accepts a long prompt (no upper bound — agent prompts are arbitrarily long)', async () => {
    const { sendTaskAction } = await import('../src/lib/actions.ts');
    const longPrompt = 'a'.repeat(5000);
    const r = await sendTaskAction({
      prompt: longPrompt,
      agentId: 'aaaaaaaa-0000-0000-0000-000000000001',
    });
    // Will likely fail downstream (no such agent in mock DB) but NOT on validation_failed.
    expect(r.ok === false && r.code === 'validation_failed').toBe(false);
  });
});

describe('getJobDetailAction — validation', () => {
  it('rejects invalid uuid', async () => {
    const { getJobDetailAction } = await import('../src/lib/actions.ts');
    const r = await getJobDetailAction('bad-id');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('validation_failed');
  });
});

describe('getJobStatusAction — validation', () => {
  it('rejects invalid uuid', async () => {
    const { getJobStatusAction } = await import('../src/lib/actions.ts');
    const r = await getJobStatusAction('bad-id');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('validation_failed');
  });
});

describe('cancelJobAction', () => {
  it('rejects invalid uuid', async () => {
    const { cancelJobAction } = await import('../src/lib/actions.ts');
    const r = await cancelJobAction('bad-id');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('validation_failed');
  });

  it('returns not_found for unknown id', async () => {
    currentDb = makeDb([]) as typeof currentDb;
    const { cancelJobAction } = await import('../src/lib/actions.ts');
    const r = await cancelJobAction('aaaaaaaa-0000-0000-0000-000000000001');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('not_found');
  });

  it('refuses already-terminal jobs (completed)', async () => {
    currentDb = makeDb([{ status: 'completed' }]) as typeof currentDb;
    const { cancelJobAction } = await import('../src/lib/actions.ts');
    const r = await cancelJobAction('aaaaaaaa-0000-0000-0000-000000000001');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('already_terminal');
  });

  it('refuses already-terminal jobs (failed)', async () => {
    currentDb = makeDb([{ status: 'failed' }]) as typeof currentDb;
    const { cancelJobAction } = await import('../src/lib/actions.ts');
    const r = await cancelJobAction('aaaaaaaa-0000-0000-0000-000000000001');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('already_terminal');
  });

  it('refuses already-terminal jobs (cancelled — re-cancel is a no-op)', async () => {
    currentDb = makeDb([{ status: 'cancelled' }]) as typeof currentDb;
    const { cancelJobAction } = await import('../src/lib/actions.ts');
    const r = await cancelJobAction('aaaaaaaa-0000-0000-0000-000000000001');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('already_terminal');
  });

  it('flips status to cancelled for pending / processing / awaiting_*', async () => {
    for (const status of ['pending', 'processing', 'awaiting_approval', 'awaiting_delegation']) {
      currentDb = makeDb([{ status }]) as typeof currentDb;
      const { cancelJobAction } = await import('../src/lib/actions.ts');
      const r = await cancelJobAction('aaaaaaaa-0000-0000-0000-000000000001');
      expect(r.ok, `should cancel from ${status}`).toBe(true);
      if (r.ok) expect(r.data.status).toBe('cancelled');

      // The action must have issued the cascade UPDATE via the raw-SQL
      // escape hatch (WITH RECURSIVE). Drift catch: if the action ever
      // forgets to actually run it, this assertion fails.
      const executeSpy = (currentDb as unknown as { execute: ReturnType<typeof vi.fn> }).execute;
      expect(executeSpy).toHaveBeenCalled();
    }
  });

  it('cascade UPDATE includes a recursive CTE over descendants', async () => {
    // Smoke check on the raw SQL — the cascade is correctness-critical
    // and we want to catch a regression that silently strips the
    // WITH RECURSIVE part (would leave child jobs running).
    currentDb = makeDb([{ status: 'processing' }]) as typeof currentDb;
    const { cancelJobAction } = await import('../src/lib/actions.ts');
    const r = await cancelJobAction('aaaaaaaa-0000-0000-0000-000000000001');
    expect(r.ok).toBe(true);

    const executeSpy = (currentDb as unknown as { execute: ReturnType<typeof vi.fn> }).execute;
    expect(executeSpy).toHaveBeenCalledTimes(1);
    // The sql template is opaque from the mock side, but it stringifies
    // to its query text + params layout; we just sanity-check that the
    // recursive CTE keyword reached the executor.
    const callArg = executeSpy.mock.calls[0]?.[0];
    const text = JSON.stringify(callArg);
    expect(text).toContain('RECURSIVE');
    expect(text).toContain('descendants');
    expect(text).toContain('parent_job_id');
  });
});

// ─── DB path tests ────────────────────────────────────────────────────────────

describe('createAgentAction — db path', () => {
  it('returns ok with id when insert succeeds', async () => {
    currentDb = makeDb([{ id: 'aaaaaaaa-0000-0000-0000-000000000001' }]) as typeof currentDb;
    const { createAgentAction } = await import('../src/lib/actions.ts');
    const r = await createAgentAction({
      slug: 'my-agent',
      name: 'My Agent',
      personality: 'Hello.',
      model: 'google/gemma-4-31b',
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data.id).toBe('aaaaaaaa-0000-0000-0000-000000000001');
  });

  it('defaults role to worker (no orchestrator_mode, no assignments)', async () => {
    currentDb = makeDb([{ id: 'aaaaaaaa-0000-0000-0000-000000000002' }]) as typeof currentDb;
    const { createAgentAction } = await import('../src/lib/actions.ts');
    const r = await createAgentAction({
      slug: 'worker-agent',
      name: 'Worker',
      personality: 'I do work.',
      model: 'gpt-4',
    });
    expect(r.ok).toBe(true);
    // Capture the values passed to insert(...).values(...)
    const insertSpy = (currentDb as unknown as { insert: ReturnType<typeof vi.fn> }).insert;
    const valuesCalls = insertSpy.mock.results
      .flatMap((res) => (res.value as { values?: ReturnType<typeof vi.fn> }).values?.mock?.calls)
      .filter(Boolean) as unknown[][];
    // First insert is into `agents`. Assert role/orchestrator_mode.
    const firstInsert = valuesCalls[0]?.[0] as Record<string, unknown> | undefined;
    expect(firstInsert?.['role']).toBe('agent');
    expect(firstInsert?.['orchestratorMode']).toBe(null);
  });

  it('rejects subAgentIds when role is worker', async () => {
    const { createAgentAction } = await import('../src/lib/actions.ts');
    const r = await createAgentAction({
      slug: 'bad',
      name: 'Bad',
      personality: 'Hi',
      model: 'gpt-4',
      role: 'worker',
      subAgentIds: ['11111111-1111-1111-1111-111111111111'],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('validation_failed');
  });

  it('rejects subAgentIds that do not belong to the entity', async () => {
    // First select() returns [] (no matching subagents found)
    currentDb = makeDb([]) as typeof currentDb;
    const { createAgentAction } = await import('../src/lib/actions.ts');
    const r = await createAgentAction({
      slug: 'router',
      name: 'Router',
      personality: 'I delegate',
      model: 'gpt-4',
      role: 'router',
      subAgentIds: ['11111111-1111-1111-1111-111111111111'],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('validation_failed');
  });

  it('creates a router with role=orchestrator and orchestrator_mode=router', async () => {
    // The chain mock returns the same rows for every awaited query, so we
    // pick a single row that satisfies BOTH the validation select (must
    // return exactly subAgentIds.length rows) AND the agents insert
    // (.returning() needs at least one row with an id).
    const subId = '22222222-2222-2222-2222-222222222222';
    currentDb = makeDb([{ id: subId }]) as typeof currentDb;

    const { createAgentAction } = await import('../src/lib/actions.ts');
    const r = await createAgentAction({
      slug: 'my-router',
      name: 'My Router',
      personality: 'I route.',
      model: 'gpt-4',
      role: 'router',
      subAgentIds: [subId],
    });
    expect(r.ok).toBe(true);

    const insertSpy = (currentDb as unknown as { insert: ReturnType<typeof vi.fn> }).insert;
    // Two inserts must have happened: agents + agentAssignments
    expect(insertSpy.mock.calls.length).toBeGreaterThanOrEqual(2);

    const valuesCalls = insertSpy.mock.results
      .flatMap((res) => (res.value as { values?: ReturnType<typeof vi.fn> }).values?.mock?.calls)
      .filter(Boolean) as unknown[][];

    // First insert: agents row with role='orchestrator', orchestratorMode='router'
    const agentValues = valuesCalls[0]?.[0] as Record<string, unknown> | undefined;
    expect(agentValues?.['role']).toBe('orchestrator');
    expect(agentValues?.['orchestratorMode']).toBe('router');

    // Second insert: agent_assignments with one row pointing at subId
    const assignmentValues = valuesCalls[1]?.[0] as Array<Record<string, unknown>> | undefined;
    expect(Array.isArray(assignmentValues)).toBe(true);
    expect(assignmentValues?.[0]?.['subAgentId']).toBe(subId);
  });

  it('creates a planner with orchestrator_mode=planner', async () => {
    const subId = '33333333-3333-3333-3333-333333333333';
    currentDb = makeDb([{ id: subId }]) as typeof currentDb;

    const { createAgentAction } = await import('../src/lib/actions.ts');
    const r = await createAgentAction({
      slug: 'my-planner',
      name: 'My Planner',
      personality: 'I plan.',
      model: 'gpt-4',
      role: 'planner',
      subAgentIds: [subId],
    });
    expect(r.ok).toBe(true);

    const insertSpy = (currentDb as unknown as { insert: ReturnType<typeof vi.fn> }).insert;
    const valuesCalls = insertSpy.mock.results
      .flatMap((res) => (res.value as { values?: ReturnType<typeof vi.fn> }).values?.mock?.calls)
      .filter(Boolean) as unknown[][];
    const agentValues = valuesCalls[0]?.[0] as Record<string, unknown> | undefined;
    expect(agentValues?.['role']).toBe('orchestrator');
    expect(agentValues?.['orchestratorMode']).toBe('planner');
  });

  it('returns db_error when insert returns no row', async () => {
    currentDb = makeDb([]) as typeof currentDb;
    const { createAgentAction } = await import('../src/lib/actions.ts');
    const r = await createAgentAction({
      slug: 'my-agent',
      name: 'My Agent',
      personality: 'Hello.',
      model: 'google/gemma-4-31b',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('db_error');
  });

  it('rejects missing model', async () => {
    const { createAgentAction } = await import('../src/lib/actions.ts');
    const r = await createAgentAction({
      slug: 'my-agent',
      name: 'My Agent',
      personality: 'Hello.',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('validation_failed');
  });
});

describe('updateAgentAction — failover chain (Guard 2)', () => {
  it('persists the (keyId, model) fallback chain and strips the primary', async () => {
    const agentId = 'aaaaaaaa-0000-0000-0000-000000000010';
    const primary = '11111111-1111-1111-1111-111111111111';
    const fb = '22222222-2222-2222-2222-222222222222';
    // select() returns the existing agent so the ownership check passes.
    currentDb = makeDb([{ id: agentId }]) as typeof currentDb;
    const { updateAgentAction } = await import('../src/lib/actions.ts');
    const r = await updateAgentAction({
      id: agentId,
      name: 'A',
      personality: 'p',
      model: 'gpt-4',
      llmKeyId: primary,
      // Primary deliberately included — the action must strip it so the chain
      // stays disjoint, keeping the fallback's chosen model.
      fallbackChain: [
        { keyId: primary, model: 'gpt-4' },
        { keyId: fb, model: 'deepseek/deepseek-v4-pro' },
      ],
      role: 'worker',
      subAgentIds: [],
    });
    expect(r.ok).toBe(true);

    // Inspect the real patch handed to .update(agents).set(patch).
    const updateSpy = (currentDb as unknown as { update: ReturnType<typeof vi.fn> }).update;
    const setCalls = updateSpy.mock.results
      .flatMap((res) => (res.value as { set?: ReturnType<typeof vi.fn> }).set?.mock?.calls)
      .filter(Boolean) as unknown[][];
    const patch = setCalls[0]?.[0] as Record<string, unknown> | undefined;
    expect(patch?.['fallbackChain']).toEqual([{ keyId: fb, model: 'deepseek/deepseek-v4-pro' }]);
  });

  it('rejects a non-uuid keyId in the fallback chain', async () => {
    const { updateAgentAction } = await import('../src/lib/actions.ts');
    const r = await updateAgentAction({
      id: 'aaaaaaaa-0000-0000-0000-000000000010',
      name: 'A',
      personality: 'p',
      model: 'gpt-4',
      role: 'worker',
      fallbackChain: [{ keyId: 'not-a-uuid', model: '' }],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('validation_failed');
  });
});

describe('listAgentsAction', () => {
  it('returns ok with array (may be empty)', async () => {
    currentDb = makeDb([]) as typeof currentDb;
    const { listAgentsAction } = await import('../src/lib/actions.ts');
    const r = await listAgentsAction();
    expect(r.ok).toBe(true);
    if (r.ok) expect(Array.isArray(r.data)).toBe(true);
  });
});

describe('reorderAgentsAction', () => {
  it('rejects an empty array', async () => {
    const { reorderAgentsAction } = await import('../src/lib/actions.ts');
    const r = await reorderAgentsAction([]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('validation_failed');
  });

  it('rejects invalid uuids in the list', async () => {
    const { reorderAgentsAction } = await import('../src/lib/actions.ts');
    const r = await reorderAgentsAction(['aaaaaaaa-0000-0000-0000-000000000001', 'not-a-uuid']);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('validation_failed');
  });

  it('refuses when ownership check returns fewer rows than requested', async () => {
    // Only 1 row owned out of 2 requested → cross-entity attempt, fail loud.
    currentDb = makeDb([{ id: 'aaaaaaaa-0000-0000-0000-000000000001' }]) as typeof currentDb;
    const { reorderAgentsAction } = await import('../src/lib/actions.ts');
    const r = await reorderAgentsAction([
      'aaaaaaaa-0000-0000-0000-000000000001',
      'aaaaaaaa-0000-0000-0000-000000000002',
    ]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('not_found');
  });

  it('issues UPDATEs in order when all rows are owned', async () => {
    currentDb = makeDb([
      { id: 'aaaaaaaa-0000-0000-0000-000000000001' },
      { id: 'aaaaaaaa-0000-0000-0000-000000000002' },
    ]) as typeof currentDb;
    const { reorderAgentsAction } = await import('../src/lib/actions.ts');
    const r = await reorderAgentsAction([
      'aaaaaaaa-0000-0000-0000-000000000001',
      'aaaaaaaa-0000-0000-0000-000000000002',
    ]);
    expect(r.ok).toBe(true);
    const updateSpy = (currentDb as unknown as { update: ReturnType<typeof vi.fn> }).update;
    // Two UPDATEs expected — one per id.
    expect(updateSpy).toHaveBeenCalledTimes(2);
  });

  it('deduplicates accidental repeats while preserving first-seen order', async () => {
    // The action should ignore the second occurrence of id-A. The ownership
    // SELECT only needs to verify 2 distinct ids exist.
    currentDb = makeDb([
      { id: 'aaaaaaaa-0000-0000-0000-000000000001' },
      { id: 'aaaaaaaa-0000-0000-0000-000000000002' },
    ]) as typeof currentDb;
    const { reorderAgentsAction } = await import('../src/lib/actions.ts');
    const r = await reorderAgentsAction([
      'aaaaaaaa-0000-0000-0000-000000000001',
      'aaaaaaaa-0000-0000-0000-000000000002',
      'aaaaaaaa-0000-0000-0000-000000000001', // duplicate
    ]);
    expect(r.ok).toBe(true);
    const updateSpy = (currentDb as unknown as { update: ReturnType<typeof vi.fn> }).update;
    // Still only 2 UPDATEs — the duplicate was collapsed.
    expect(updateSpy).toHaveBeenCalledTimes(2);
  });
});

describe('listAgentGroupsAction', () => {
  it('returns ok with array (empty workspace)', async () => {
    currentDb = makeDb([]) as typeof currentDb;
    const { listAgentGroupsAction } = await import('../src/lib/actions.ts');
    const r = await listAgentGroupsAction();
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data).toEqual([]);
  });
});

describe('listJobsAction', () => {
  it('returns ok with array', async () => {
    currentDb = makeDb([
      {
        id: 'bbbbbbbb-0000-0000-0000-000000000001',
        status: 'completed',
        channel: 'api',
        task: 'Test',
        entityId: '00000000-0000-0000-0000-000000000002',
        result: null,
        error: null,
        chainCount: 0,
        inputTokens: 0,
        outputTokens: 0,
        createdAt: new Date(),
        completedAt: null,
        agentId: null,
      },
    ]) as typeof currentDb;
    const { listJobsAction } = await import('../src/lib/actions.ts');
    const r = await listJobsAction({ limit: 10 });
    expect(r.ok).toBe(true);
    if (r.ok) expect(Array.isArray(r.data)).toBe(true);
  });
});

describe('getJobDetailAction — db path', () => {
  it('returns not_found when select returns empty', async () => {
    currentDb = makeDb([]) as typeof currentDb;
    const { getJobDetailAction } = await import('../src/lib/actions.ts');
    const r = await getJobDetailAction('cccccccc-0000-0000-0000-000000000001');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('not_found');
  });

  it('returns ok with agent name + children when job row exists', async () => {
    // Action now does a join → row shape is { job: {...}, agentName, agentSlug }.
    // Same chain mock returns the same rows for the children query, which is
    // fine: the test only asserts on the job's id + agent metadata.
    currentDb = makeDb([
      {
        job: {
          id: 'cccccccc-0000-0000-0000-000000000001',
          entityId: '00000000-0000-0000-0000-000000000002',
          status: 'completed',
          channel: 'api',
          task: 'Test',
          messages: [],
          result: null,
          error: null,
          chainCount: 0,
          turn: 0,
          inputTokens: 0,
          outputTokens: 0,
          totalDurationMs: 0,
          delegationDepth: 0,
          systemPrompt: null,
          parentJobId: null,
          createdAt: new Date(),
          completedAt: null,
        },
        agentName: 'Concierge',
        agentSlug: 'concierge',
      },
    ]) as typeof currentDb;
    const { getJobDetailAction } = await import('../src/lib/actions.ts');
    const r = await getJobDetailAction('cccccccc-0000-0000-0000-000000000001');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.id).toBe('cccccccc-0000-0000-0000-000000000001');
      expect(r.data.agentName).toBe('Concierge');
      expect(r.data.agentSlug).toBe('concierge');
      expect(Array.isArray(r.data.children)).toBe(true);
    }
  });

  it('scopes the children-by-parentJobId query to the session entity (defense in depth)', async () => {
    currentDb = makeDb([
      {
        job: {
          id: 'cccccccc-0000-0000-0000-000000000001',
          entityId: LOCAL_ENTITY_ID,
          status: 'completed',
          channel: 'api',
          task: 'Test',
          messages: [],
          result: null,
          error: null,
          chainCount: 0,
          turn: 0,
          inputTokens: 0,
          outputTokens: 0,
          totalDurationMs: 0,
          delegationDepth: 0,
          systemPrompt: null,
          parentJobId: null,
          createdAt: new Date(),
          completedAt: null,
        },
        agentName: 'Concierge',
        agentSlug: 'concierge',
      },
    ]) as typeof currentDb;
    const { getJobDetailAction } = await import('../src/lib/actions.ts');
    await getJobDetailAction('cccccccc-0000-0000-0000-000000000001');

    // Same chain object is returned for every select() call — its `where` mock
    // accumulates every `.where()` call the action made, in order. The second
    // one is the children-by-parentJobId query; assert it now carries an
    // entity_id predicate bound to the session's entity (not just parentJobId).
    const selectSpy = (currentDb as unknown as { select: ReturnType<typeof vi.fn> }).select;
    const chainObj = selectSpy.mock.results[0]!.value as { where: ReturnType<typeof vi.fn> };
    const childrenWhereArg = chainObj.where.mock.calls[1]?.[0];
    const serialized = serializeSqlCondition(childrenWhereArg);
    expect(serialized).toContain('"name":"entity_id"');
    expect(serialized).toContain(LOCAL_ENTITY_ID);
  });
});

describe('listDelegationRunsAction', () => {
  it('scopes the parent-name-resolution query to the session entity (defense in depth)', async () => {
    currentDb = makeDb([
      {
        id: 'dddddddd-0000-0000-0000-000000000001',
        agentName: 'Worker',
        agentSlug: 'worker',
        agentAvatarUrl: null,
        task: 'child task',
        channel: 'api',
        status: 'completed',
        inputTokens: 0,
        outputTokens: 0,
        costUsd: 0,
        createdAt: new Date(),
        completedAt: null,
        parentJobId: 'dddddddd-0000-0000-0000-000000000002',
      },
    ]) as typeof currentDb;
    const { listDelegationRunsAction } = await import('../src/lib/actions.ts');
    const r = await listDelegationRunsAction({});
    expect(r.ok).toBe(true);

    // select() and selectDistinct() both resolve to the SAME chain object in
    // this mock, so its `where` mock accumulates every `.where()` call the
    // action made, in order: [0] rows query, [1] childParents (selectDistinct),
    // [2] parent-name resolution (pj) — the one this fix scopes.
    const selectSpy = (currentDb as unknown as { select: ReturnType<typeof vi.fn> }).select;
    const chainObj = selectSpy.mock.results[0]!.value as { where: ReturnType<typeof vi.fn> };
    const pjWhereArg = chainObj.where.mock.calls[2]?.[0];
    const serialized = serializeSqlCondition(pjWhereArg);
    expect(serialized).toContain('"name":"entity_id"');
    expect(serialized).toContain(LOCAL_ENTITY_ID);
  });
});

describe('getChatJobStatusAction', () => {
  it('scopes the children-by-parentJobId query to the session entity (alignment with getJobDetailAction)', async () => {
    currentDb = makeDb([
      {
        status: 'completed',
        result: 'done',
        agentName: 'Worker',
        agentSlug: 'worker',
      },
    ]) as typeof currentDb;
    const { getChatJobStatusAction } = await import('../src/lib/actions.ts');
    const r = await getChatJobStatusAction('cccccccc-0000-0000-0000-000000000009');
    expect(r.ok).toBe(true);

    // Same shared-chain trick: [0] is the job-by-id query, [1] is the
    // children-by-parentJobId query this fix scopes.
    const selectSpy = (currentDb as unknown as { select: ReturnType<typeof vi.fn> }).select;
    const chainObj = selectSpy.mock.results[0]!.value as { where: ReturnType<typeof vi.fn> };
    const childrenWhereArg = chainObj.where.mock.calls[1]?.[0];
    const serialized = serializeSqlCondition(childrenWhereArg);
    expect(serialized).toContain('"name":"entity_id"');
    expect(serialized).toContain(LOCAL_ENTITY_ID);
  });
});

// ─── Telegram actions ─────────────────────────────────────────────────────────

describe('getAgentTelegramConfigAction', () => {
  it('rejects non-uuid agentId', async () => {
    const { getAgentTelegramConfigAction } = await import('../src/lib/actions.ts');
    const r = await getAgentTelegramConfigAction('not-uuid');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('validation_failed');
  });

  it('returns not_found when agent does not belong to entity', async () => {
    currentDb = makeDb([]) as typeof currentDb;
    const { getAgentTelegramConfigAction } = await import('../src/lib/actions.ts');
    const r = await getAgentTelegramConfigAction('aaaaaaaa-0000-0000-0000-000000000099');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('not_found');
  });

  it('returns disconnected when agent has no token', async () => {
    currentDb = makeDb([
      {
        id: 'aaaaaaaa-0000-0000-0000-000000000010',
        slug: 'my-agent',
        name: 'My Agent',
        botToken: null,
        botUsername: null,
      },
    ]) as typeof currentDb;
    const { getAgentTelegramConfigAction } = await import('../src/lib/actions.ts');
    const r = await getAgentTelegramConfigAction('aaaaaaaa-0000-0000-0000-000000000010');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.status).toBe('disconnected');
      expect(r.data.botUsername).toBe(null);
    }
  });

  it('returns connected when agent has a token', async () => {
    currentDb = makeDb([
      {
        id: 'aaaaaaaa-0000-0000-0000-000000000011',
        slug: 'my-agent',
        name: 'My Agent',
        botToken: 'tok',
        botUsername: 'my_bot',
      },
    ]) as typeof currentDb;
    const { getAgentTelegramConfigAction } = await import('../src/lib/actions.ts');
    const r = await getAgentTelegramConfigAction('aaaaaaaa-0000-0000-0000-000000000011');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.status).toBe('connected');
      expect(r.data.botUsername).toBe('my_bot');
    }
  });
});

describe('configureAgentTelegramAction', () => {
  it('rejects malformed token', async () => {
    const { configureAgentTelegramAction } = await import('../src/lib/actions.ts');
    const r = await configureAgentTelegramAction({
      agentId: 'aaaaaaaa-0000-0000-0000-000000000020',
      botToken: 'not-a-real-token',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('validation_failed');
  });

  it('returns not_found when agent does not exist', async () => {
    currentDb = makeDb([]) as typeof currentDb;
    const { configureAgentTelegramAction } = await import('../src/lib/actions.ts');
    const r = await configureAgentTelegramAction({
      agentId: 'aaaaaaaa-0000-0000-0000-000000000021',
      botToken: '123456789:ABCDEFGHIJKLMNOP_QRSTUVWXYZabcdef-G',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('not_found');
  });

  it('maps invalid token from Telegram to telegram_invalid_token', async () => {
    currentDb = makeDb([
      { id: 'aaaaaaaa-0000-0000-0000-000000000022', slug: 'agent-x', name: 'Agent X' },
    ]) as typeof currentDb;
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: false, description: 'Unauthorized' }), { status: 401 }),
    );

    const { configureAgentTelegramAction } = await import('../src/lib/actions.ts');
    const r = await configureAgentTelegramAction({
      agentId: 'aaaaaaaa-0000-0000-0000-000000000022',
      botToken: '123456789:ABCDEFGHIJKLMNOP_QRSTUVWXYZabcdef-G',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('telegram_invalid_token');
    fetchSpy.mockRestore();
  });

  it('persists token + bot_username + offset=0 when no backlog', async () => {
    currentDb = makeDb([
      { id: 'aaaaaaaa-0000-0000-0000-000000000023', slug: 'agent-y', name: 'Agent Y' },
    ]) as typeof currentDb;
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    // 1st: getMe → ok
    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          ok: true,
          result: {
            id: 1,
            is_bot: true,
            first_name: 'My',
            username: 'my_bot',
            can_join_groups: true,
          },
        }),
        { status: 200 },
      ),
    );
    // 2nd: getUpdates(-1, 0) → empty backlog
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true, result: [] }), { status: 200 }),
    );

    const { configureAgentTelegramAction } = await import('../src/lib/actions.ts');
    const r = await configureAgentTelegramAction({
      agentId: 'aaaaaaaa-0000-0000-0000-000000000023',
      botToken: '123456789:ABCDEFGHIJKLMNOP_QRSTUVWXYZabcdef-G',
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.status).toBe('connected');
      expect(r.data.botUsername).toBe('my_bot');
    }

    // Two fetches: getMe + drain (getUpdates).
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(String(fetchSpy.mock.calls[0]![0])).toContain('/getMe');
    expect(String(fetchSpy.mock.calls[1]![0])).toContain('/getUpdates');

    // No backlog → offset stays at 0.
    const updateSpy = (currentDb as unknown as { update: ReturnType<typeof vi.fn> }).update;
    const setSpy = updateSpy.mock.results[0]!.value as { set: ReturnType<typeof vi.fn> };
    const setArg = setSpy.set.mock.calls[0]![0] as Record<string, unknown>;
    expect(setArg['telegramBotToken']).toBe('123456789:ABCDEFGHIJKLMNOP_QRSTUVWXYZabcdef-G');
    expect(setArg['telegramBotUsername']).toBe('my_bot');
    expect(setArg['telegramOffset']).toBe(0);

    fetchSpy.mockRestore();
  });

  it('drains backlog: offset = max(update_id) + 1 when reconnecting', async () => {
    // Simulates user disconnecting, sending messages while disconnected, then
    // reconnecting. Telegram returns the buffered updates. We must NOT replay
    // them.
    currentDb = makeDb([
      { id: 'aaaaaaaa-0000-0000-0000-000000000040', slug: 'agent-r', name: 'Reconnect' },
    ]) as typeof currentDb;
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    // 1st: getMe
    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          ok: true,
          result: { id: 1, is_bot: true, first_name: 'R', username: 'r_bot' },
        }),
        { status: 200 },
      ),
    );
    // 2nd: getUpdates(-1, 0, limit:1) → returns the latest pending update
    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          ok: true,
          result: [
            {
              update_id: 12345,
              message: {
                chat: { id: 1, type: 'private' },
                from: { first_name: 'X' },
                text: 'I sent this while you were disconnected',
              },
            },
          ],
        }),
        { status: 200 },
      ),
    );

    const { configureAgentTelegramAction } = await import('../src/lib/actions.ts');
    const r = await configureAgentTelegramAction({
      agentId: 'aaaaaaaa-0000-0000-0000-000000000040',
      botToken: '123456789:ABCDEFGHIJKLMNOP_QRSTUVWXYZabcdef-G',
    });
    expect(r.ok).toBe(true);

    // Verify drain hits getUpdates with offset=-1, timeout=0, limit=1
    const drainCall = fetchSpy.mock.calls[1]!;
    expect(String(drainCall[0])).toContain('/getUpdates');
    const drainBody = JSON.parse(drainCall[1]?.body as string) as Record<string, unknown>;
    expect(drainBody['offset']).toBe(-1);
    expect(drainBody['timeout']).toBe(0);
    expect(drainBody['limit']).toBe(1);

    // Persisted offset must be update_id + 1 so the poller starts AFTER the
    // buffered update — no replay.
    const updateSpy = (currentDb as unknown as { update: ReturnType<typeof vi.fn> }).update;
    const setSpy = updateSpy.mock.results[0]!.value as { set: ReturnType<typeof vi.fn> };
    const setArg = setSpy.set.mock.calls[0]![0] as Record<string, unknown>;
    expect(setArg['telegramOffset']).toBe(12346);

    fetchSpy.mockRestore();
  });

  it('still configures (offset=0) when the drain call fails', async () => {
    // Drain is best-effort. A network blip during configure must not block
    // the user from connecting their bot.
    currentDb = makeDb([
      { id: 'aaaaaaaa-0000-0000-0000-000000000041', slug: 'agent-d', name: 'Drain Fail' },
    ]) as typeof currentDb;
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          ok: true,
          result: { id: 1, is_bot: true, first_name: 'D', username: 'd_bot' },
        }),
        { status: 200 },
      ),
    );
    // Drain throws — caught, configure proceeds.
    fetchSpy.mockRejectedValueOnce(new Error('network down'));

    const { configureAgentTelegramAction } = await import('../src/lib/actions.ts');
    const r = await configureAgentTelegramAction({
      agentId: 'aaaaaaaa-0000-0000-0000-000000000041',
      botToken: '123456789:ABCDEFGHIJKLMNOP_QRSTUVWXYZabcdef-G',
    });
    expect(r.ok).toBe(true);

    const updateSpy = (currentDb as unknown as { update: ReturnType<typeof vi.fn> }).update;
    const setSpy = updateSpy.mock.results[0]!.value as { set: ReturnType<typeof vi.fn> };
    const setArg = setSpy.set.mock.calls[0]![0] as Record<string, unknown>;
    expect(setArg['telegramBotToken']).toBe('123456789:ABCDEFGHIJKLMNOP_QRSTUVWXYZabcdef-G');
    // Fallback to 0 when drain failed
    expect(setArg['telegramOffset']).toBe(0);

    fetchSpy.mockRestore();
  });
});

describe('disconnectAgentTelegramAction', () => {
  it('rejects non-uuid agentId', async () => {
    const { disconnectAgentTelegramAction } = await import('../src/lib/actions.ts');
    const r = await disconnectAgentTelegramAction('not-uuid');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('validation_failed');
  });

  it('returns not_found when agent does not exist', async () => {
    currentDb = makeDb([]) as typeof currentDb;
    const { disconnectAgentTelegramAction } = await import('../src/lib/actions.ts');
    const r = await disconnectAgentTelegramAction('aaaaaaaa-0000-0000-0000-000000000030');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('not_found');
  });

  it('clears all telegram fields without calling Telegram', async () => {
    currentDb = makeDb([{ id: 'aaaaaaaa-0000-0000-0000-000000000031' }]) as typeof currentDb;

    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const { disconnectAgentTelegramAction } = await import('../src/lib/actions.ts');
    const r = await disconnectAgentTelegramAction('aaaaaaaa-0000-0000-0000-000000000031');
    expect(r.ok).toBe(true);

    // No Telegram API call needed — disconnect is a pure DB clear.
    // The runner's TelegramManager will detect the cleared token on its next
    // refresh tick and abort the poller.
    expect(fetchSpy).not.toHaveBeenCalled();

    const updateSpy = (currentDb as unknown as { update: ReturnType<typeof vi.fn> }).update;
    const setSpy = updateSpy.mock.results[0]!.value as { set: ReturnType<typeof vi.fn> };
    const setArg = setSpy.set.mock.calls[0]![0] as Record<string, unknown>;
    expect(setArg['telegramBotToken']).toBe(null);
    expect(setArg['telegramBotUsername']).toBe(null);
    expect(setArg['telegramOffset']).toBe(null);

    fetchSpy.mockRestore();
  });
});

// ─── Memory Actions ───────────────────────────────────────────────────────────

describe('listMemoriesAction', () => {
  it('rejects invalid agentId', async () => {
    const { listMemoriesAction } = await import('../src/lib/actions.ts');
    const r = await listMemoriesAction({ agentId: 'not-uuid' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('validation_failed');
  });

  it('rejects invalid category', async () => {
    const { listMemoriesAction } = await import('../src/lib/actions.ts');
    const r = await listMemoriesAction({ category: 'bogus' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('validation_failed');
  });

  it('returns paged result with agent name resolved', async () => {
    const agentId = 'aaaaaaaa-0000-0000-0000-000000000040';
    memoryMocks.listMemories.mockResolvedValue({
      items: [
        {
          id: 'bbbbbbbb-0000-0000-0000-000000000040',
          entity_id: 'cccccccc-0000-0000-0000-000000000000',
          agent_id: agentId,
          fact: 'User likes concise answers.',
          category: 'preference',
          importance: 4,
          source: 'agent',
          skill_tags: ['style'],
          memory_layer: null,
          valid_from: null,
          valid_to: null,
          fact_hash: null,
          archived: false,
          last_accessed_at: null,
          access_count: 2,
          created_at: '2026-05-02T10:00:00.000Z',
          updated_at: '2026-05-02T10:00:00.000Z',
        },
      ],
      page: 1,
      pageSize: 50,
      totalCount: 1,
      hasMore: false,
    });
    // Second call (db lookup for agent name) returns the agent row
    currentDb = makeDb([{ id: agentId, name: 'Boris', slug: 'boris' }]) as typeof currentDb;

    const { listMemoriesAction } = await import('../src/lib/actions.ts');
    const r = await listMemoriesAction({});
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.items.length).toBe(1);
      expect(r.data.items[0]!.agentName).toBe('Boris');
      expect(r.data.items[0]!.agentSlug).toBe('boris');
      expect(r.data.totalCount).toBe(1);
    }
  });

  it('passes archived flag through to listMemories', async () => {
    memoryMocks.listMemories.mockResolvedValue({
      items: [],
      page: 1,
      pageSize: 50,
      totalCount: 0,
      hasMore: false,
    });
    const { listMemoriesAction } = await import('../src/lib/actions.ts');
    const r = await listMemoriesAction({ archived: true });
    expect(r.ok).toBe(true);
    expect(memoryMocks.listMemories).toHaveBeenCalled();
    const call = memoryMocks.listMemories.mock.calls.at(-1)!;
    expect((call[1] as { archived: boolean }).archived).toBe(true);
  });
});

describe('archiveMemoryAction', () => {
  it('rejects non-uuid id', async () => {
    const { archiveMemoryAction } = await import('../src/lib/actions.ts');
    const r = await archiveMemoryAction('bad');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('validation_failed');
  });

  it('translates MemoryNotFoundError into not_found', async () => {
    const { MemoryNotFoundError } = await import('@nodal-agents/memory');
    memoryMocks.updateMemory.mockRejectedValueOnce(new MemoryNotFoundError('id'));
    const { archiveMemoryAction } = await import('../src/lib/actions.ts');
    const r = await archiveMemoryAction('aaaaaaaa-0000-0000-0000-000000000050');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('not_found');
  });

  it('calls updateMemory with archived: true', async () => {
    memoryMocks.updateMemory.mockResolvedValueOnce({});
    const { archiveMemoryAction } = await import('../src/lib/actions.ts');
    const r = await archiveMemoryAction('aaaaaaaa-0000-0000-0000-000000000051');
    expect(r.ok).toBe(true);
    const call = memoryMocks.updateMemory.mock.calls.at(-1)!;
    expect((call[3] as { archived: boolean }).archived).toBe(true);
  });
});

describe('unarchiveMemoryAction', () => {
  it('rejects non-uuid id', async () => {
    const { unarchiveMemoryAction } = await import('../src/lib/actions.ts');
    const r = await unarchiveMemoryAction('bad');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('validation_failed');
  });

  it('calls updateMemory with archived: false', async () => {
    memoryMocks.updateMemory.mockResolvedValueOnce({});
    const { unarchiveMemoryAction } = await import('../src/lib/actions.ts');
    const r = await unarchiveMemoryAction('aaaaaaaa-0000-0000-0000-000000000052');
    expect(r.ok).toBe(true);
    const call = memoryMocks.updateMemory.mock.calls.at(-1)!;
    expect((call[3] as { archived: boolean }).archived).toBe(false);
  });
});

describe('deleteMemoryAction', () => {
  it('rejects non-uuid id', async () => {
    const { deleteMemoryAction } = await import('../src/lib/actions.ts');
    const r = await deleteMemoryAction('bad');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('validation_failed');
  });

  it('translates MemoryNotFoundError into not_found', async () => {
    const { MemoryNotFoundError } = await import('@nodal-agents/memory');
    memoryMocks.deleteMemory.mockRejectedValueOnce(new MemoryNotFoundError('id'));
    const { deleteMemoryAction } = await import('../src/lib/actions.ts');
    const r = await deleteMemoryAction('aaaaaaaa-0000-0000-0000-000000000060');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('not_found');
  });

  it('returns ok on successful delete', async () => {
    memoryMocks.deleteMemory.mockResolvedValueOnce(undefined);
    const { deleteMemoryAction } = await import('../src/lib/actions.ts');
    const r = await deleteMemoryAction('aaaaaaaa-0000-0000-0000-000000000061');
    expect(r.ok).toBe(true);
  });
});

describe('updateMemoryImportanceAction', () => {
  it('rejects a non-uuid id', async () => {
    const { updateMemoryImportanceAction } = await import('../src/lib/actions.ts');
    const r = await updateMemoryImportanceAction('bad', 4);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('validation_failed');
  });

  it('rejects an importance outside 1-5', async () => {
    const { updateMemoryImportanceAction } = await import('../src/lib/actions.ts');
    const tooHigh = await updateMemoryImportanceAction('aaaaaaaa-0000-0000-0000-000000000070', 6);
    expect(tooHigh.ok).toBe(false);
    if (!tooHigh.ok) expect(tooHigh.code).toBe('validation_failed');

    const tooLow = await updateMemoryImportanceAction('aaaaaaaa-0000-0000-0000-000000000070', 0);
    expect(tooLow.ok).toBe(false);
    if (!tooLow.ok) expect(tooLow.code).toBe('validation_failed');
  });

  it('translates MemoryNotFoundError into not_found (e.g. a fact scoped to another entity)', async () => {
    const { MemoryNotFoundError } = await import('@nodal-agents/memory');
    memoryMocks.updateMemory.mockRejectedValueOnce(new MemoryNotFoundError('id'));
    const { updateMemoryImportanceAction } = await import('../src/lib/actions.ts');
    const r = await updateMemoryImportanceAction('aaaaaaaa-0000-0000-0000-000000000071', 5);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('not_found');
  });

  it('pins the fact: sets importance AND importance_locked=true, scoped to the session entity', async () => {
    memoryMocks.updateMemory.mockResolvedValueOnce({});
    const { updateMemoryImportanceAction } = await import('../src/lib/actions.ts');
    const r = await updateMemoryImportanceAction('aaaaaaaa-0000-0000-0000-000000000072', 5);
    expect(r.ok).toBe(true);
    const call = memoryMocks.updateMemory.mock.calls.at(-1)!;
    // updateMemory(db, id, entityId, updates)
    expect(call[1]).toBe('aaaaaaaa-0000-0000-0000-000000000072');
    expect(call[2]).toBe(LOCAL_ENTITY_ID);
    expect(call[3]).toEqual({ importance: 5, importance_locked: true });
  });
});

describe('unpinMemoryImportanceAction', () => {
  it('rejects a non-uuid id', async () => {
    const { unpinMemoryImportanceAction } = await import('../src/lib/actions.ts');
    const r = await unpinMemoryImportanceAction('bad');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('validation_failed');
  });

  it('translates MemoryNotFoundError into not_found', async () => {
    const { MemoryNotFoundError } = await import('@nodal-agents/memory');
    memoryMocks.updateMemory.mockRejectedValueOnce(new MemoryNotFoundError('id'));
    const { unpinMemoryImportanceAction } = await import('../src/lib/actions.ts');
    const r = await unpinMemoryImportanceAction('aaaaaaaa-0000-0000-0000-000000000073');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('not_found');
  });

  it('clears importance_locked WITHOUT touching importance, scoped to the session entity', async () => {
    memoryMocks.updateMemory.mockResolvedValueOnce({});
    const { unpinMemoryImportanceAction } = await import('../src/lib/actions.ts');
    const r = await unpinMemoryImportanceAction('aaaaaaaa-0000-0000-0000-000000000074');
    expect(r.ok).toBe(true);
    const call = memoryMocks.updateMemory.mock.calls.at(-1)!;
    expect(call[1]).toBe('aaaaaaaa-0000-0000-0000-000000000074');
    expect(call[2]).toBe(LOCAL_ENTITY_ID);
    expect(call[3]).toEqual({ importance_locked: false });
    // Importance itself is deliberately absent from the update payload.
    expect(call[3]).not.toHaveProperty('importance');
  });
});

describe('createMemoryAction', () => {
  it('rejects an empty fact', async () => {
    const { createMemoryAction } = await import('../src/lib/actions.ts');
    const r = await createMemoryAction({ fact: '' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('validation_failed');
  });

  it('writes a source=manual fact scoped to the session entity, with defaults applied', async () => {
    memoryMocks.createMemory.mockResolvedValueOnce({});
    const { createMemoryAction } = await import('../src/lib/actions.ts');
    const r = await createMemoryAction({ fact: 'Prefers concise replies.' });
    expect(r.ok).toBe(true);
    const call = memoryMocks.createMemory.mock.calls.at(-1)!;
    expect(call[1]).toEqual({
      entity_id: LOCAL_ENTITY_ID,
      agent_id: null,
      fact: 'Prefers concise replies.',
      category: 'context',
      importance: 3,
      source: 'manual',
      skill_tags: [],
    });
  });

  it('passes through an explicit category and importance from the New Memory modal', async () => {
    memoryMocks.createMemory.mockResolvedValueOnce({});
    const { createMemoryAction } = await import('../src/lib/actions.ts');
    const r = await createMemoryAction({
      fact: 'Runs ComfyUI on port 8188.',
      category: 'outcome',
      importance: 5,
    });
    expect(r.ok).toBe(true);
    const call = memoryMocks.createMemory.mock.calls.at(-1)!;
    expect((call[1] as { category: string }).category).toBe('outcome');
    expect((call[1] as { importance: number }).importance).toBe(5);
  });

  it('treats a duplicate fact as a no-op success (idempotent)', async () => {
    const { MemoryDuplicateError } = await import('@nodal-agents/memory');
    memoryMocks.createMemory.mockRejectedValueOnce(new MemoryDuplicateError('existing-id'));
    const { createMemoryAction } = await import('../src/lib/actions.ts');
    const r = await createMemoryAction({ fact: 'Already known fact.' });
    expect(r.ok).toBe(true);
  });
});

describe('searchMemoriesAction', () => {
  it('returns an empty list without querying for a blank query', async () => {
    memoryMocks.keywordSearchMemories.mockClear();
    const { searchMemoriesAction } = await import('../src/lib/actions.ts');
    const r = await searchMemoriesAction('   ');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data).toEqual([]);
    expect(memoryMocks.keywordSearchMemories).not.toHaveBeenCalled();
  });

  it('searches with touch:false, scoped to the session entity, and resolves agent names', async () => {
    const agentId = 'aaaaaaaa-0000-0000-0000-000000000080';
    memoryMocks.keywordSearchMemories.mockResolvedValueOnce([
      {
        id: 'bbbbbbbb-0000-0000-0000-000000000080',
        entity_id: LOCAL_ENTITY_ID,
        agent_id: agentId,
        fact: 'Runs ComfyUI on port 8188.',
        category: 'context',
        importance: 3,
        importance_locked: false,
        source: 'agent',
        skill_tags: [],
        memory_layer: null,
        valid_from: null,
        valid_to: null,
        fact_hash: null,
        archived: false,
        last_accessed_at: null,
        access_count: 0,
        created_at: '2026-07-01T00:00:00.000Z',
        updated_at: '2026-07-01T00:00:00.000Z',
      },
    ]);
    currentDb = makeDb([{ id: agentId, name: 'Boris', slug: 'boris' }]) as typeof currentDb;

    const { searchMemoriesAction } = await import('../src/lib/actions.ts');
    const r = await searchMemoriesAction('comfyui');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.length).toBe(1);
      expect(r.data[0]!.agentName).toBe('Boris');
    }

    const call = memoryMocks.keywordSearchMemories.mock.calls.at(-1)!;
    expect((call[1] as { touch: boolean }).touch).toBe(false);
    expect((call[1] as { entityId: string }).entityId).toBe(LOCAL_ENTITY_ID);
    expect((call[1] as { query: string }).query).toBe('comfyui');
  });

  it('surfaces a search failure as db_error', async () => {
    memoryMocks.keywordSearchMemories.mockRejectedValueOnce(new Error('boom'));
    const { searchMemoriesAction } = await import('../src/lib/actions.ts');
    const r = await searchMemoriesAction('anything');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('db_error');
  });
});

// ─── Connector Actions ────────────────────────────────────────────────────────

describe('listConnectorsAction', () => {
  it('returns empty instances and full catalog when entity has none', async () => {
    currentDb = makeDb([]) as typeof currentDb;
    const { listConnectorsAction } = await import('../src/lib/actions.ts');
    const { CONNECTOR_CATALOG } = await import('../src/lib/connector-catalog.ts');
    const r = await listConnectorsAction();
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.instances.length).toBe(0);
      expect(r.data.catalog.length).toBe(CONNECTOR_CATALOG.length);
    }
  });

  it('attaches a connector row to its catalog slug', async () => {
    const id = 'aaaaaaaa-0000-0000-0000-000000000070';
    currentDb = makeDb([
      {
        id,
        slug: 'notion',
        name: 'Notion',
        authType: 'api_key',
        active: true,
        apiKey: 'secret_xxx',
        oauthAccessToken: null,
        oauthRefreshToken: null,
        oauthClientId: null,
        oauthAccountName: null,
        oauthScopes: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]) as typeof currentDb;
    const { listConnectorsAction } = await import('../src/lib/actions.ts');
    const r = await listConnectorsAction();
    expect(r.ok).toBe(true);
    if (r.ok) {
      const notion = r.data.instances.find((i) => i.slug === 'notion');
      expect(notion?.id).toBe(id);
      expect(notion?.hasApiKey).toBe(true);
      // Catalog still contains all entries
      expect(r.data.catalog.find((c) => c.slug === 'gmail')).toBeDefined();
      // No Gmail instance row exists
      expect(r.data.instances.find((i) => i.slug === 'gmail')).toBeUndefined();
    }
  });
});

describe('saveApiKeyConnectorAction', () => {
  it('rejects unknown slug', async () => {
    const { saveApiKeyConnectorAction } = await import('../src/lib/actions.ts');
    const r = await saveApiKeyConnectorAction({ slug: 'mystery', apiKey: 'x' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('validation_failed');
  });

  it('rejects empty apiKey', async () => {
    const { saveApiKeyConnectorAction } = await import('../src/lib/actions.ts');
    const r = await saveApiKeyConnectorAction({ slug: 'notion', apiKey: '' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('validation_failed');
  });

  it('rejects an oauth slug for the api-key path', async () => {
    const { saveApiKeyConnectorAction } = await import('../src/lib/actions.ts');
    const r = await saveApiKeyConnectorAction({ slug: 'gmail', apiKey: 'x' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('validation_failed');
  });

  it('inserts a new row (pure INSERT — every call creates a new instance)', async () => {
    // Multi-instance brique: saveApiKeyConnectorAction is now a pure INSERT.
    // The mock's insert().values().returning() resolves with [{ id }].
    const id = 'aaaaaaaa-0000-0000-0000-000000000071';
    currentDb = makeDb([{ id }]) as typeof currentDb;
    const { saveApiKeyConnectorAction } = await import('../src/lib/actions.ts');
    const r = await saveApiKeyConnectorAction({
      slug: 'notion',
      name: 'My Notion',
      apiKey: 'secret_abc',
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data.id).toBe(id);
    // INSERT must have been called (no UPDATE)
    const insertSpy = (currentDb as unknown as { insert: ReturnType<typeof vi.fn> }).insert;
    expect(insertSpy).toHaveBeenCalled();
    const updateSpy = (currentDb as unknown as { update: ReturnType<typeof vi.fn> }).update;
    expect(updateSpy).not.toHaveBeenCalled();
    // Assert the values payload: apiKey encrypted, authType and active correct.
    const valuesFn = (insertSpy.mock.results[0]?.value as { values?: ReturnType<typeof vi.fn> })
      .values;
    const insertValues = valuesFn?.mock.calls[0]?.[0] as Record<string, unknown> | undefined;
    expect(insertValues).toBeDefined();
    // Brique 34 (Agent B): apiKey must be encrypted at rest — assert enc:v1: prefix.
    expect(typeof insertValues?.['apiKey']).toBe('string');
    expect(insertValues?.['apiKey'] as string).toMatch(/^enc:v1:/);
    expect(insertValues?.['authType']).toBe('api_key');
    expect(insertValues?.['active']).toBe(true);
  });
});

// saveOauthConnectorAction was removed in Brique 34 v3.
// OAuth credentials are now created via /api/oauth/[provider]/start → callback
// and then linked to connectors via assignCredentialAction.

describe('assignCredentialAction — Brique 34 v3', () => {
  it('rejects non-uuid connectorId', async () => {
    const { assignCredentialAction } = await import('../src/lib/actions.ts');
    const r = await assignCredentialAction('bad-id', 'aaaaaaaa-0000-0000-0000-000000000099');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('validation_failed');
  });

  it('rejects non-uuid credentialId when provided', async () => {
    const { assignCredentialAction } = await import('../src/lib/actions.ts');
    const r = await assignCredentialAction('aaaaaaaa-0000-0000-0000-000000000090', 'bad-cred-id');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('validation_failed');
  });

  it('returns not_found when connector does not exist', async () => {
    currentDb = makeDb([]) as typeof currentDb;
    const { assignCredentialAction } = await import('../src/lib/actions.ts');
    const r = await assignCredentialAction(
      'aaaaaaaa-0000-0000-0000-000000000091',
      'aaaaaaaa-0000-0000-0000-000000000092',
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('not_found');
  });

  it('accepts null credentialId to unassign (unlink) a credential', async () => {
    // Mock: connector exists (first select), credential check skipped (null), update succeeds.
    const existingConnectorId = 'aaaaaaaa-0000-0000-0000-000000000093';
    currentDb = makeDb([
      { id: existingConnectorId, slug: 'google-drive', authType: 'oauth2' },
    ]) as typeof currentDb;
    const { assignCredentialAction } = await import('../src/lib/actions.ts');
    const r = await assignCredentialAction(existingConnectorId, null);
    expect(r.ok).toBe(true);
  });

  it('I-10 (audit #2): a DB error detail is never reflected to the client', async () => {
    const existingConnectorId = 'aaaaaaaa-0000-0000-0000-000000000094';
    const db = makeDb([
      { id: existingConnectorId, slug: 'google-drive', authType: 'oauth2' },
    ]) as unknown as { update: unknown };
    // Simulate an internal error carrying detail (host/port/relation names)
    // that must never reach the UI.
    db.update = vi.fn(() => {
      throw new Error('relation "connectors" does not exist at 10.0.0.5:5432');
    });
    currentDb = db as typeof currentDb;

    const { assignCredentialAction } = await import('../src/lib/actions.ts');
    const r = await assignCredentialAction(existingConnectorId, null);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.message).not.toContain('10.0.0.5');
      expect(r.message).not.toContain('relation "connectors"');
      expect(r.code).toBe('db_error');
    }
  });
});

describe('createOrAssignOAuthConnectorAction — I-10 error detail leak (audit #2)', () => {
  it('a DB error detail is never reflected to the client', async () => {
    const credentialId = 'aaaaaaaa-0000-0000-0000-000000000095';
    const db = makeDb([
      { id: credentialId, ownerUserId: '00000000-0000-0000-0000-000000000001', type: 'google-oauth' },
    ]) as unknown as { insert: unknown };
    db.insert = vi.fn(() => {
      throw new Error('duplicate key value violates unique constraint at 10.0.0.5:5432');
    });
    currentDb = db as typeof currentDb;

    const { createOrAssignOAuthConnectorAction } = await import('../src/lib/actions.ts');
    const r = await createOrAssignOAuthConnectorAction('google-drive', credentialId);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.message).not.toContain('10.0.0.5');
      expect(r.message).not.toContain('duplicate key value');
      expect(r.code).toBe('db_error');
    }
  });
});

describe('saveApiKeyConnectorAction — new api_key providers (regression)', () => {
  it.each(['apify', 'firecrawl', 'tavily', 'airtable'])(
    'saves %s api_key with enc:v1: prefix',
    async (slug) => {
      const insertedId = 'aaaaaaaa-0000-0000-0000-000000000080';
      currentDb = makeDb([{ id: insertedId }]) as typeof currentDb;
      const { saveApiKeyConnectorAction } = await import('../src/lib/actions.ts');
      // name is now REQUIRED — pass a display name
      const r = await saveApiKeyConnectorAction({
        slug,
        name: `My ${slug}`,
        apiKey: 'test-api-key-value',
      });
      expect(r.ok).toBe(true);
      // Assert the apiKey in the INSERT values payload is encrypted.
      const insertSpy = (currentDb as unknown as { insert: ReturnType<typeof vi.fn> }).insert;
      const valuesFn = (
        insertSpy.mock.results.at(-1)?.value as { values?: ReturnType<typeof vi.fn> }
      )?.values;
      const insertValues = valuesFn?.mock.calls[0]?.[0] as Record<string, unknown> | undefined;
      expect(typeof insertValues?.['apiKey']).toBe('string');
      expect(insertValues?.['apiKey'] as string).toMatch(/^enc:v1:/);
    },
  );
});

describe('deleteConnectorAction', () => {
  it('rejects non-uuid id', async () => {
    const { deleteConnectorAction } = await import('../src/lib/actions.ts');
    const r = await deleteConnectorAction('bad');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('validation_failed');
  });

  it('returns not_found when connector does not exist', async () => {
    currentDb = makeDb([]) as typeof currentDb;
    const { deleteConnectorAction } = await import('../src/lib/actions.ts');
    const r = await deleteConnectorAction('aaaaaaaa-0000-0000-0000-000000000073');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('not_found');
  });

  it('returns ok when delete succeeds', async () => {
    currentDb = makeDb([{ id: 'aaaaaaaa-0000-0000-0000-000000000074' }]) as typeof currentDb;
    const { deleteConnectorAction } = await import('../src/lib/actions.ts');
    const r = await deleteConnectorAction('aaaaaaaa-0000-0000-0000-000000000074');
    expect(r.ok).toBe(true);
  });
});

// ─── Approval Actions ─────────────────────────────────────────────────────────

describe('listApprovalsAction', () => {
  it('returns ok with array (may be empty)', async () => {
    currentDb = makeDb([]) as typeof currentDb;
    const { listApprovalsAction } = await import('../src/lib/actions.ts');
    const r = await listApprovalsAction();
    expect(r.ok).toBe(true);
    if (r.ok) expect(Array.isArray(r.data)).toBe(true);
  });

  it('joins agent name and job task into the row', async () => {
    currentDb = makeDb([
      {
        id: 'aaaaaaaa-0000-0000-0000-000000000080',
        jobId: 'aaaaaaaa-0000-0000-0000-000000000081',
        agentId: 'aaaaaaaa-0000-0000-0000-000000000082',
        agentName: 'Boris',
        agentSlug: 'boris',
        toolName: 'gmail_send',
        toolInput: { to: 'x@example.com' },
        status: 'pending',
        requestedAt: new Date(),
        resolvedAt: null,
        resolvedBy: null,
        expiresAt: new Date(),
        notes: null,
        jobTask: 'send the email',
      },
    ]) as typeof currentDb;
    const { listApprovalsAction } = await import('../src/lib/actions.ts');
    const r = await listApprovalsAction();
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.length).toBe(1);
      expect(r.data[0]!.agentName).toBe('Boris');
      expect(r.data[0]!.jobTask).toBe('send the email');
    }
  });
});

describe('resolveApprovalAction', () => {
  it('rejects invalid uuid', async () => {
    const { resolveApprovalAction } = await import('../src/lib/actions.ts');
    const r = await resolveApprovalAction({ approvalRequestId: 'bad', decision: 'approve' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('validation_failed');
  });

  it('rejects unknown decision', async () => {
    const { resolveApprovalAction } = await import('../src/lib/actions.ts');
    const r = await resolveApprovalAction({
      approvalRequestId: 'aaaaaaaa-0000-0000-0000-000000000090',
      decision: 'maybe',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('validation_failed');
  });

  it('returns not_found (no runner call) when the approval does not belong to the caller entity', async () => {
    // IDOR guard: resolveApprovalAction must scope its DB lookup to the
    // caller's entity BEFORE forwarding to the runner. An empty scoped
    // select simulates "belongs to another tenant" (or doesn't exist) —
    // either way the caller gets an identical not_found, no cross-tenant leak.
    currentDb = makeDb([]) as typeof currentDb;
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const { resolveApprovalAction } = await import('../src/lib/actions.ts');
    const r = await resolveApprovalAction({
      approvalRequestId: 'aaaaaaaa-0000-0000-0000-000000000095',
      decision: 'approve',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('not_found');
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('proceeds to the runner when the approval belongs to the caller entity', async () => {
    currentDb = makeDb([
      { id: 'aaaaaaaa-0000-0000-0000-000000000096' },
    ]) as typeof currentDb;
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          jobId: 'aaaaaaaa-0000-0000-0000-000000000097',
          decision: 'approve',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    const { resolveApprovalAction } = await import('../src/lib/actions.ts');
    const r = await resolveApprovalAction({
      approvalRequestId: 'aaaaaaaa-0000-0000-0000-000000000096',
      decision: 'approve',
    });
    expect(r.ok).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    fetchSpy.mockRestore();
  });

  it('signs the runner call with WORKER_SECRET and returns ok on 200', async () => {
    // The IDOR guard (FIX #2) does an entity-scoped select before forwarding
    // to the runner — this test is about the runner call itself, so give it
    // its own non-empty row rather than relying on state left by a sibling
    // test (order-dependence caught by isolation review: `vitest -t` alone
    // on this test failed before this line was added).
    currentDb = makeDb([{ id: 'aaaaaaaa-0000-0000-0000-000000000090' }]) as typeof currentDb;
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          ok: true,
          jobId: 'aaaaaaaa-0000-0000-0000-000000000091',
          status: 'pending',
          decision: 'approve',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    const { resolveApprovalAction } = await import('../src/lib/actions.ts');
    const r = await resolveApprovalAction({
      approvalRequestId: 'aaaaaaaa-0000-0000-0000-000000000092',
      decision: 'approve',
    });
    expect(r.ok).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const headers = (fetchSpy.mock.calls[0]![1] as RequestInit).headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer test-bearer-789');
    fetchSpy.mockRestore();
  });

  it('returns runner_unreachable when fetch throws', async () => {
    // Own its currentDb (see note above) — the IDOR guard must find the
    // approval before this test can reach the fetch-throws path.
    currentDb = makeDb([{ id: 'aaaaaaaa-0000-0000-0000-000000000093' }]) as typeof currentDb;
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'));
    const { resolveApprovalAction } = await import('../src/lib/actions.ts');
    const r = await resolveApprovalAction({
      approvalRequestId: 'aaaaaaaa-0000-0000-0000-000000000093',
      decision: 'approve',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('runner_unreachable');
    fetchSpy.mockRestore();
  });

  it('forwards the runner error code on non-200', async () => {
    // Own its currentDb (see note above) — the IDOR guard must find the
    // approval before this test can reach the non-200 forwarding path.
    currentDb = makeDb([{ id: 'aaaaaaaa-0000-0000-0000-000000000094' }]) as typeof currentDb;
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ error: 'approval_already_resolved' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    const { resolveApprovalAction } = await import('../src/lib/actions.ts');
    const r = await resolveApprovalAction({
      approvalRequestId: 'aaaaaaaa-0000-0000-0000-000000000094',
      decision: 'approve',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('approval_already_resolved');
    fetchSpy.mockRestore();
  });
});

// ─── Skill Actions ────────────────────────────────────────────────────────────

describe('listSkillsAction', () => {
  it('returns empty array when entity has no skills', async () => {
    currentDb = makeDb([]) as typeof currentDb;
    const { listSkillsAction } = await import('../src/lib/actions.ts');
    const r = await listSkillsAction();
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data).toEqual([]);
  });

  it('attaches assignment count from the second query', async () => {
    // Chain mock returns the same rows for every awaited query, so the
    // skills list select AND the tally select both resolve to the seeded
    // array. We pack both shapes into one object for the test.
    const skillId = 'aaaaaaaa-0000-0000-0000-000000000100';
    currentDb = makeDb([
      {
        id: skillId,
        name: 'Notion Power User',
        slug: 'notion-power',
        content: 'Use Notion well',
        description: 'Helpful Notion stuff',
        active: true,
        requiredBuiltins: ['save_memory'],
        createdBy: 'user',
        createdAt: new Date(),
        updatedAt: new Date(),
        skillId,
        c: '3',
      },
    ]) as typeof currentDb;
    const { listSkillsAction } = await import('../src/lib/actions.ts');
    const r = await listSkillsAction();
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.length).toBe(1);
      expect(r.data[0]!.assignmentCount).toBe(3);
      expect(r.data[0]!.requiredBuiltins).toEqual(['save_memory']);
    }
  });

  // P2b (F-6 follow-up): isSystem must reflect createdBy — the actual
  // provenance column — not slug string membership. Before this fix, a
  // same-entity custom skill that merely shared a catalog slug (createdBy=
  // 'user') would have been mislabeled isSystem:true; a genuine system row
  // must still report isSystem:true regardless of its slug.
  it('reports isSystem:false for a user-created skill, even one sharing a catalog-looking slug', async () => {
    const skillId = 'aaaaaaaa-0000-0000-0000-000000000103';
    currentDb = makeDb([
      {
        id: skillId,
        name: 'Impostor',
        slug: 'web-search', // looks like a system slug
        content: 'not the real thing',
        description: null,
        active: true,
        requiredBuiltins: [],
        createdBy: 'user',
        createdAt: new Date(),
        updatedAt: new Date(),
        skillId,
        c: '0',
      },
    ]) as typeof currentDb;
    const { listSkillsAction } = await import('../src/lib/actions.ts');
    const r = await listSkillsAction();
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data[0]!.isSystem).toBe(false);
  });

  it('reports isSystem:true for a genuine system skill (createdBy=system)', async () => {
    const skillId = 'aaaaaaaa-0000-0000-0000-000000000104';
    currentDb = makeDb([
      {
        id: skillId,
        name: 'Web Search',
        slug: 'web-search',
        content: 'the real thing',
        description: null,
        active: true,
        requiredBuiltins: [],
        createdBy: 'system',
        createdAt: new Date(),
        updatedAt: new Date(),
        skillId,
        c: '0',
      },
    ]) as typeof currentDb;
    const { listSkillsAction } = await import('../src/lib/actions.ts');
    const r = await listSkillsAction();
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data[0]!.isSystem).toBe(true);
  });
});

describe('createSkillAction', () => {
  it('rejects bad slug', async () => {
    const { createSkillAction } = await import('../src/lib/actions.ts');
    const r = await createSkillAction({
      slug: 'BadSlug',
      name: 'X',
      content: 'Y',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('validation_failed');
  });

  it('rejects empty content', async () => {
    const { createSkillAction } = await import('../src/lib/actions.ts');
    const r = await createSkillAction({
      slug: 'ok-slug',
      name: 'X',
      content: '',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('validation_failed');
  });

  it('returns ok with id on insert', async () => {
    const id = 'aaaaaaaa-0000-0000-0000-000000000101';
    currentDb = makeDb([{ id }]) as typeof currentDb;
    const { createSkillAction } = await import('../src/lib/actions.ts');
    const r = await createSkillAction({
      slug: 'my-skill',
      name: 'My Skill',
      content: 'Do X.',
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data.id).toBe(id);
  });

  // P2b (F-6 follow-up): a slug reserved by the system catalog is refused
  // outright — closes the squat vector at the creation choke point, before
  // any DB write.
  it('rejects a slug reserved by the system catalog', async () => {
    expect(systemSkillSlugs.length).toBeGreaterThan(0);
    const reservedSlug = systemSkillSlugs[0]!;
    currentDb = makeDb([]) as typeof currentDb;
    const { createSkillAction } = await import('../src/lib/actions.ts');
    const r = await createSkillAction({
      slug: reservedSlug,
      name: 'Squat Attempt',
      content: 'Do X.',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe('validation_failed');
      expect(r.message).toContain(reservedSlug);
    }
    // The mocked db's insert chain was never reached with a real write path
    // that would matter here — the point is the repo call itself returns
    // slug_reserved before any insert semantics are exercised.
  });
});

describe('deleteSkillAction', () => {
  it('rejects non-uuid', async () => {
    const { deleteSkillAction } = await import('../src/lib/actions.ts');
    const r = await deleteSkillAction('bad');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('validation_failed');
  });

  it('returns not_found when missing', async () => {
    currentDb = makeDb([]) as typeof currentDb;
    const { deleteSkillAction } = await import('../src/lib/actions.ts');
    const r = await deleteSkillAction('aaaaaaaa-0000-0000-0000-000000000102');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('not_found');
  });
});

describe('listSkillAssignmentsAction', () => {
  it('rejects non-uuid', async () => {
    const { listSkillAssignmentsAction } = await import('../src/lib/actions.ts');
    const r = await listSkillAssignmentsAction('bad');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('validation_failed');
  });

  it('returns not_found when skill does not exist', async () => {
    currentDb = makeDb([]) as typeof currentDb;
    const { listSkillAssignmentsAction } = await import('../src/lib/actions.ts');
    const r = await listSkillAssignmentsAction('aaaaaaaa-0000-0000-0000-000000000103');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('not_found');
  });
});

describe('assignSkillAction', () => {
  it('rejects bad input', async () => {
    const { assignSkillAction } = await import('../src/lib/actions.ts');
    const r = await assignSkillAction({ skillId: 'bad', agentId: 'also bad' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('validation_failed');
  });
});

describe('unassignSkillAction', () => {
  it('rejects bad input', async () => {
    const { unassignSkillAction } = await import('../src/lib/actions.ts');
    const r = await unassignSkillAction({});
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('validation_failed');
  });

  it('returns ok on successful delete', async () => {
    currentDb = makeDb([]) as typeof currentDb;
    const { unassignSkillAction } = await import('../src/lib/actions.ts');
    const r = await unassignSkillAction({
      skillId: 'aaaaaaaa-0000-0000-0000-000000000104',
      agentId: 'aaaaaaaa-0000-0000-0000-000000000105',
    });
    expect(r.ok).toBe(true);
  });
});

// ─── Tool Call Logs ───────────────────────────────────────────────────────────

describe('listToolNamesAction', () => {
  it('returns distinct tool names sorted by the underlying selectDistinct query (Brique 36)', async () => {
    // Drizzle's `selectDistinct().orderBy()` already returns the distinct
    // tool_name list sorted alphabetically. We assert the action surfaces
    // exactly that — no extra transformation that would re-introduce dups
    // or change ordering.
    currentDb = makeDb([
      { toolName: 'apify_run_actor' },
      { toolName: 'firecrawl_search' },
      { toolName: 'tavily_search' },
    ]) as typeof currentDb;
    const { listToolNamesAction } = await import('../src/lib/actions.ts');
    const r = await listToolNamesAction();
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data).toEqual(['apify_run_actor', 'firecrawl_search', 'tavily_search']);
    }
  });

  it('returns empty array when no tool calls have been logged yet', async () => {
    currentDb = makeDb([]) as typeof currentDb;
    const { listToolNamesAction } = await import('../src/lib/actions.ts');
    const r = await listToolNamesAction();
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data).toEqual([]);
  });
});

describe('listToolCallsAction', () => {
  it('rejects invalid agentId', async () => {
    const { listToolCallsAction } = await import('../src/lib/actions.ts');
    const r = await listToolCallsAction({ agentId: 'not-uuid' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('validation_failed');
  });

  it('rejects invalid jobId', async () => {
    const { listToolCallsAction } = await import('../src/lib/actions.ts');
    const r = await listToolCallsAction({ jobId: 'bad' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('validation_failed');
  });

  it('rejects pageSize over 200', async () => {
    const { listToolCallsAction } = await import('../src/lib/actions.ts');
    const r = await listToolCallsAction({ pageSize: 500 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('validation_failed');
  });

  it('returns rows with agent name resolved', async () => {
    const agentId = 'aaaaaaaa-0000-0000-0000-000000000110';
    currentDb = makeDb([
      {
        id: 'aaaaaaaa-0000-0000-0000-000000000111',
        jobId: 'aaaaaaaa-0000-0000-0000-000000000112',
        agentId,
        toolName: 'notion_search',
        toolInput: { query: 'foo' },
        toolOutput: '{"results":[]}',
        durationMs: 320,
        turn: 2,
        createdAt: new Date(),
        name: 'Boris',
        slug: 'boris',
      },
    ]) as typeof currentDb;
    // Chain mock returns the same rows for both queries; the second
    // select expects { id, name, slug } — we ensure the action surfaces
    // the items array regardless of the lookup result.
    const { listToolCallsAction } = await import('../src/lib/actions.ts');
    const r = await listToolCallsAction({});
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data.items.length).toBe(1);
  });
});

// ─── Stats Action ─────────────────────────────────────────────────────────────

describe('getEntityStatsAction', () => {
  it('aggregates status counts and tokens', async () => {
    // The chain mock returns the same rows for every query. We pack a
    // shape that satisfies all three rollups at once: status group,
    // tool-call count, agent count, per-agent rollup.
    currentDb = makeDb([
      {
        status: 'completed',
        count: '4',
        inputTokens: '2000',
        outputTokens: '1000',
        durationMs: '8000',
        // tool-call count + agent count expected as `count`
        // per-agent rollup
        agentId: 'aaaaaaaa-0000-0000-0000-000000000120',
        agentName: 'Boris',
        agentSlug: 'boris',
        jobCount: '4',
      },
    ]) as typeof currentDb;
    const { getEntityStatsAction } = await import('../src/lib/actions.ts');
    const r = await getEntityStatsAction();
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.totalJobs).toBe(4);
      expect(r.data.statusCounts['completed']).toBe(4);
      expect(r.data.totalInputTokens).toBe(2000);
      expect(r.data.totalOutputTokens).toBe(1000);
      // avg duration over completed jobs
      expect(r.data.avgDurationMs).toBe(2000);
    }
  });

  it('returns empty stats when entity has no activity', async () => {
    currentDb = makeDb([]) as typeof currentDb;
    const { getEntityStatsAction } = await import('../src/lib/actions.ts');
    const r = await getEntityStatsAction();
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.totalJobs).toBe(0);
      expect(r.data.totalInputTokens).toBe(0);
      expect(r.data.avgDurationMs).toBe(null);
      expect(r.data.perAgent).toEqual([]);
    }
  });
});

describe('getSettingsAction', () => {
  it('returns env-derived settings + session ids', async () => {
    const { getSettingsAction } = await import('../src/lib/actions.ts');
    const r = await getSettingsAction();
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.authMode).toBe('local-trust');
      expect(r.data.runnerUrl).toBe('http://localhost:3001');
      expect(r.data.workerSecretConfigured).toBe(true);
      expect(typeof r.data.user.userId).toBe('string');
      expect(typeof r.data.user.entityId).toBe('string');
    }
  });
});

// ─── Automation Actions ──────────────────────────────────────────────────────

describe('listSchedulesAction', () => {
  it('returns ok with array', async () => {
    currentDb = makeDb([]) as typeof currentDb;
    const { listSchedulesAction } = await import('../src/lib/actions.ts');
    const r = await listSchedulesAction();
    expect(r.ok).toBe(true);
    if (r.ok) expect(Array.isArray(r.data)).toBe(true);
  });
});

describe('createScheduleAction', () => {
  it('rejects bad agentId', async () => {
    const { createScheduleAction } = await import('../src/lib/actions.ts');
    const r = await createScheduleAction({
      agentId: 'not-uuid',
      name: 'X',
      cronExpr: '0 9 * * *',
      task: 'Y',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('validation_failed');
  });

  it('rejects empty cron expr', async () => {
    const { createScheduleAction } = await import('../src/lib/actions.ts');
    const r = await createScheduleAction({
      agentId: 'aaaaaaaa-0000-0000-0000-000000000130',
      name: 'X',
      cronExpr: '',
      task: 'Y',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('validation_failed');
  });

  it('returns ok when insert succeeds', async () => {
    const id = 'aaaaaaaa-0000-0000-0000-000000000131';
    currentDb = makeDb([{ id }]) as typeof currentDb;
    const { createScheduleAction } = await import('../src/lib/actions.ts');
    const r = await createScheduleAction({
      agentId: 'aaaaaaaa-0000-0000-0000-000000000132',
      name: 'Daily',
      cronExpr: '0 9 * * *',
      task: 'Summarize the day',
    });
    expect(r.ok).toBe(true);
  });

  it('persists notifyOnSuccess (defaults to false when omitted)', async () => {
    // Explicit true.
    currentDb = makeDb([{ id: 'aaaaaaaa-0000-0000-0000-000000000136' }]) as typeof currentDb;
    const { createScheduleAction } = await import('../src/lib/actions.ts');
    const r = await createScheduleAction({
      agentId: 'aaaaaaaa-0000-0000-0000-000000000137',
      name: 'Daily',
      cronExpr: '0 9 * * *',
      task: 'Summarize the day',
      notifyOnSuccess: true,
    });
    expect(r.ok).toBe(true);
    const insertSpy = (currentDb as unknown as { insert: ReturnType<typeof vi.fn> }).insert;
    const valuesOn = (insertSpy.mock.results.at(-1)?.value as { values?: ReturnType<typeof vi.fn> })
      ?.values?.mock.calls[0]?.[0] as Record<string, unknown> | undefined;
    expect(valuesOn?.['notifyOnSuccess']).toBe(true);

    // Omitted → defaults to false (opt-in).
    currentDb = makeDb([{ id: 'aaaaaaaa-0000-0000-0000-000000000138' }]) as typeof currentDb;
    const { createScheduleAction: create2 } = await import('../src/lib/actions.ts');
    const r2 = await create2({
      agentId: 'aaaaaaaa-0000-0000-0000-000000000137',
      name: 'Daily',
      cronExpr: '0 9 * * *',
      task: 'Summarize the day',
    });
    expect(r2.ok).toBe(true);
    const insertSpy2 = (currentDb as unknown as { insert: ReturnType<typeof vi.fn> }).insert;
    const valuesOff = (
      insertSpy2.mock.results.at(-1)?.value as { values?: ReturnType<typeof vi.fn> }
    )?.values?.mock.calls[0]?.[0] as Record<string, unknown> | undefined;
    expect(valuesOff?.['notifyOnSuccess']).toBe(false);
  });
});

describe('duplicateScheduleAction', () => {
  it('rejects a non-uuid id', async () => {
    const { duplicateScheduleAction } = await import('../src/lib/actions.ts');
    const r = await duplicateScheduleAction('bad');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('validation_failed');
  });

  it('returns not_found when the source schedule does not exist', async () => {
    currentDb = makeDbMixed({ select: [], insert: [] }) as typeof currentDb;
    const { duplicateScheduleAction } = await import('../src/lib/actions.ts');
    const r = await duplicateScheduleAction('aaaaaaaa-0000-0000-0000-000000000200');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('not_found');
  });

  it('copies the config, names it "(copy)", and creates it PAUSED with no runtime state', async () => {
    currentDb = makeDbMixed({
      select: [
        {
          agentId: 'aaaaaaaa-0000-0000-0000-000000000201',
          type: 'cron',
          name: 'Daily digest',
          cronExpr: '0 9 * * *',
          task: 'Summarize the day',
          notifyOnSuccess: true,
        },
      ],
      insert: [{ id: 'aaaaaaaa-0000-0000-0000-000000000202' }],
    }) as typeof currentDb;
    const { duplicateScheduleAction } = await import('../src/lib/actions.ts');
    const r = await duplicateScheduleAction('aaaaaaaa-0000-0000-0000-000000000203');
    expect(r.ok).toBe(true);

    const insertSpy = (currentDb as unknown as { insert: ReturnType<typeof vi.fn> }).insert;
    const values = (insertSpy.mock.results.at(-1)?.value as { values?: ReturnType<typeof vi.fn> })
      ?.values?.mock.calls[0]?.[0] as Record<string, unknown> | undefined;
    // Config is copied verbatim…
    expect(values?.['agentId']).toBe('aaaaaaaa-0000-0000-0000-000000000201');
    expect(values?.['cronExpr']).toBe('0 9 * * *');
    expect(values?.['task']).toBe('Summarize the day');
    expect(values?.['notifyOnSuccess']).toBe(true);
    // …with a "(copy)" name…
    expect(values?.['name']).toBe('Daily digest (copy)');
    // …and the safety behavior: paused, no carried-over next run.
    expect(values?.['active']).toBe(false);
    expect(values?.['nextRun']).toBeNull();
  });
});

describe('toggleScheduleAction', () => {
  it('rejects non-uuid', async () => {
    const { toggleScheduleAction } = await import('../src/lib/actions.ts');
    const r = await toggleScheduleAction('bad');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('validation_failed');
  });

  it('returns not_found when missing', async () => {
    currentDb = makeDb([]) as typeof currentDb;
    const { toggleScheduleAction } = await import('../src/lib/actions.ts');
    const r = await toggleScheduleAction('aaaaaaaa-0000-0000-0000-000000000133');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('not_found');
  });

  it('flips active when row exists', async () => {
    currentDb = makeDb([
      { id: 'aaaaaaaa-0000-0000-0000-000000000134', active: true },
    ]) as typeof currentDb;
    const { toggleScheduleAction } = await import('../src/lib/actions.ts');
    const r = await toggleScheduleAction('aaaaaaaa-0000-0000-0000-000000000134');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data.active).toBe(false);
  });
});

describe('deleteScheduleAction', () => {
  it('rejects non-uuid', async () => {
    const { deleteScheduleAction } = await import('../src/lib/actions.ts');
    const r = await deleteScheduleAction('bad');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('validation_failed');
  });

  it('returns not_found when missing', async () => {
    currentDb = makeDb([]) as typeof currentDb;
    const { deleteScheduleAction } = await import('../src/lib/actions.ts');
    const r = await deleteScheduleAction('aaaaaaaa-0000-0000-0000-000000000135');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('not_found');
  });
});

describe('runScheduleNowAction', () => {
  it('rejects non-uuid', async () => {
    const { runScheduleNowAction } = await import('../src/lib/actions.ts');
    const r = await runScheduleNowAction('bad');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('validation_failed');
  });

  it('returns not_found when the schedule is missing or owned by another entity', async () => {
    // The action's WHERE is entity-scoped, so a cross-entity id yields an empty
    // SELECT exactly like a non-existent one.
    currentDb = makeDbMixed({ select: [] }) as typeof currentDb;
    const { runScheduleNowAction } = await import('../src/lib/actions.ts');
    const r = await runScheduleNowAction('aaaaaaaa-0000-0000-0000-000000000200');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('not_found');
  });

  it('rejects a schedule that has no task (nothing to run)', async () => {
    currentDb = makeDbMixed({
      select: [
        {
          agentId: 'aaaaaaaa-0000-0000-0000-000000000201',
          task: null,
          chatId: null,
          agentChatId: null,
        },
      ],
    }) as typeof currentDb;
    const { runScheduleNowAction } = await import('../src/lib/actions.ts');
    const r = await runScheduleNowAction('aaaaaaaa-0000-0000-0000-000000000202');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('validation_failed');
    // No job may be created for a task-less schedule.
    const insertSpy = (currentDb as unknown as { insert: ReturnType<typeof vi.fn> }).insert;
    expect(insertSpy).not.toHaveBeenCalled();
  });

  it('inserts a cron-channel job, wakes the runner, and leaves the planning untouched (notify ON → chatId set)', async () => {
    const jobId = 'aaaaaaaa-0000-0000-0000-000000000210';
    currentDb = makeDbMixed({
      select: [
        {
          agentId: 'aaaaaaaa-0000-0000-0000-000000000211',
          task: 'Summarize the inbox',
          chatId: null,
          notifyOnSuccess: true,
          agentChatId: '12345',
        },
      ],
      insert: [{ id: jobId }],
    }) as typeof currentDb;
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));

    const { runScheduleNowAction } = await import('../src/lib/actions.ts');
    const r = await runScheduleNowAction('aaaaaaaa-0000-0000-0000-000000000212');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data.jobId).toBe(jobId);

    // A real agent_jobs row was created with the cron-fire shape.
    const insertSpy = (currentDb as unknown as { insert: ReturnType<typeof vi.fn> }).insert;
    const valuesFn = (insertSpy.mock.results[0]?.value as { values?: ReturnType<typeof vi.fn> })
      .values;
    const insertValues = valuesFn?.mock.calls[0]?.[0] as Record<string, unknown> | undefined;
    expect(insertValues).toBeDefined();
    expect(insertValues?.['channel']).toBe('cron');
    expect(insertValues?.['status']).toBe('pending');
    expect(insertValues?.['task']).toBe('Summarize the inbox');
    expect(insertValues?.['agentId']).toBe('aaaaaaaa-0000-0000-0000-000000000211');
    // notify_on_success is ON → chatId carries the agent's last-seen Telegram chat
    // so the runner enforces a confirmation.
    expect(insertValues?.['chatId']).toBe('12345');
    expect(insertValues?.['messages']).toEqual([{ role: 'user', content: 'Summarize the inbox' }]);

    // A manual run must NOT reschedule the cron — no UPDATE on agent_schedules.
    const updateSpy = (currentDb as unknown as { update: ReturnType<typeof vi.fn> }).update;
    expect(updateSpy).not.toHaveBeenCalled();

    // Runner was woken with the shared bearer.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const headers = (fetchSpy.mock.calls[0]![1] as RequestInit).headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer test-bearer-789');
    fetchSpy.mockRestore();
  });

  it('leaves chatId null when the schedule did not opt into a confirmation (notify OFF → silent run)', async () => {
    const jobId = 'aaaaaaaa-0000-0000-0000-000000000220';
    currentDb = makeDbMixed({
      select: [
        {
          agentId: 'aaaaaaaa-0000-0000-0000-000000000221',
          task: 'Silent maintenance',
          chatId: null,
          notifyOnSuccess: false,
          agentChatId: '12345',
        },
      ],
      insert: [{ id: jobId }],
    }) as typeof currentDb;
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));

    const { runScheduleNowAction } = await import('../src/lib/actions.ts');
    const r = await runScheduleNowAction('aaaaaaaa-0000-0000-0000-000000000222');
    expect(r.ok).toBe(true);

    const insertSpy = (currentDb as unknown as { insert: ReturnType<typeof vi.fn> }).insert;
    const valuesFn = (insertSpy.mock.results[0]?.value as { values?: ReturnType<typeof vi.fn> })
      .values;
    const insertValues = valuesFn?.mock.calls[0]?.[0] as Record<string, unknown> | undefined;
    // notify_on_success is OFF → no delivery target even though the agent has a
    // known Telegram chat. The runner won't force a confirmation.
    expect('chatId' in (insertValues ?? {})).toBe(false);
    fetchSpy.mockRestore();
  });
});

const CHAT_CONV_ID = 'aaaaaaaa-0000-0000-0000-000000000400';

describe('sendChatMessageAction', () => {
  it('rejects an empty message', async () => {
    const { sendChatMessageAction } = await import('../src/lib/actions.ts');
    const r = await sendChatMessageAction({ conversationId: CHAT_CONV_ID, message: '' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('validation_failed');
  });

  it('fails (no runner call) when no ROOT agent is designated', async () => {
    currentDb = makeDbMixed({ select: [{ rootAgentId: null }] }) as typeof currentDb;
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const { sendChatMessageAction } = await import('../src/lib/actions.ts');
    const r = await sendChatMessageAction({ conversationId: CHAT_CONV_ID, message: 'hello' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('no_root_agent');
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('calls the runner /api/chat (no job created) and returns the reply', async () => {
    const rootId = 'aaaaaaaa-0000-0000-0000-000000000301';
    currentDb = makeDbMixed({ select: [{ rootAgentId: rootId }] }) as typeof currentDb;
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        new Response(JSON.stringify({ reply: 'Salut Quentin !' }), { status: 200 }),
      );

    const { sendChatMessageAction } = await import('../src/lib/actions.ts');
    const r = await sendChatMessageAction({
      conversationId: CHAT_CONV_ID,
      message: 'Bonjour ROOT',
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data.reply).toBe('Salut Quentin !');

    // No agent_jobs row created — chat is conversation, not a job.
    const insertSpy = (currentDb as unknown as { insert: ReturnType<typeof vi.fn> }).insert;
    expect(insertSpy).not.toHaveBeenCalled();

    // It hit the runner's /api/chat with the bearer + the right body (conversationId).
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const url = String(fetchSpy.mock.calls[0]![0]);
    expect(url).toContain('/api/chat');
    const init = fetchSpy.mock.calls[0]![1] as RequestInit;
    expect((init.headers as Record<string, string>)['Authorization']).toBe(
      'Bearer test-bearer-789',
    );
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body['agentId']).toBe(rootId);
    expect(body['conversationId']).toBe(CHAT_CONV_ID);
    expect(body['message']).toBe('Bonjour ROOT');
    fetchSpy.mockRestore();
  });

  it('treats an empty reply (agent escalated without ack text) as success, not failure', async () => {
    const rootId = 'aaaaaaaa-0000-0000-0000-000000000302';
    currentDb = makeDbMixed({ select: [{ rootAgentId: rootId }] }) as typeof currentDb;
    // HTTP 200 with an empty reply — the agent escalated via run_task and wrote
    // no acknowledgment; the dispatch card + refetch carry the info.
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ reply: '' }), { status: 200 }));

    const { sendChatMessageAction } = await import('../src/lib/actions.ts');
    const r = await sendChatMessageAction({ conversationId: CHAT_CONV_ID, message: 'crée X' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data.reply).toBe('');
    fetchSpy.mockRestore();
  });

  it('fails when the runner returns an HTTP error (e.g. empty_reply glitch → 400)', async () => {
    const rootId = 'aaaaaaaa-0000-0000-0000-000000000303';
    currentDb = makeDbMixed({ select: [{ rootAgentId: rootId }] }) as typeof currentDb;
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ error: 'empty_reply' }), { status: 400 }));

    const { sendChatMessageAction } = await import('../src/lib/actions.ts');
    const r = await sendChatMessageAction({ conversationId: CHAT_CONV_ID, message: 'hello' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('chat_failed');
    fetchSpy.mockRestore();
  });
});

describe('listConversationsAction', () => {
  it('returns empty when no ROOT is designated', async () => {
    currentDb = makeDbSeq([[{ rootAgentId: null }]]) as typeof currentDb;
    const { listConversationsAction } = await import('../src/lib/actions.ts');
    const r = await listConversationsAction();
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.rootAgentId).toBeNull();
      expect(r.data.conversations).toEqual([]);
    }
  });

  it('lists the ROOT conversations (most recent first) with a last-message preview', async () => {
    const rootId = 'aaaaaaaa-0000-0000-0000-000000000310';
    currentDb = makeDbSeq([
      [{ rootAgentId: rootId }], // entity lookup
      [{ name: 'Conciergus' }], // root agent name
      [
        { id: 'c1', title: 'Q2 board deck', updatedAt: new Date() },
        { id: 'c2', title: 'Weekend backlog', updatedAt: new Date() },
      ],
      [
        // preview messages (most recent first); first-per-conversation wins
        { conversationId: 'c1', content: 'Compiled the revenue + burn tables.' },
        { conversationId: 'c2', content: '54 tickets triaged.' },
      ],
    ]) as typeof currentDb;

    const { listConversationsAction } = await import('../src/lib/actions.ts');
    const r = await listConversationsAction();
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.rootName).toBe('Conciergus');
      expect(r.data.conversations).toHaveLength(2);
      expect(r.data.conversations[0]!.title).toBe('Q2 board deck');
      expect(r.data.conversations[0]!.preview).toBe('Compiled the revenue + burn tables.');
    }
  });
});

describe('createConversationAction', () => {
  it('fails when no ROOT agent is designated', async () => {
    currentDb = makeDbMixed({ select: [{ rootAgentId: null }] }) as typeof currentDb;
    const { createConversationAction } = await import('../src/lib/actions.ts');
    const r = await createConversationAction();
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('no_root_agent');
  });

  it('creates a conversation for the ROOT and returns its id', async () => {
    const convId = 'aaaaaaaa-0000-0000-0000-000000000420';
    currentDb = makeDbMixed({
      select: [{ rootAgentId: 'aaaaaaaa-0000-0000-0000-000000000311' }],
      insert: [{ id: convId }],
    }) as typeof currentDb;
    const { createConversationAction } = await import('../src/lib/actions.ts');
    const r = await createConversationAction();
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data.id).toBe(convId);
  });
});

describe('listChatAction', () => {
  it('rejects a non-uuid conversation id', async () => {
    const { listChatAction } = await import('../src/lib/actions.ts');
    const r = await listChatAction('bad');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('validation_failed');
  });

  it('returns not_found when the conversation is missing / cross-entity', async () => {
    currentDb = makeDbSeq([[]]) as typeof currentDb; // conversation verify → empty
    const { listChatAction } = await import('../src/lib/actions.ts');
    const r = await listChatAction(CHAT_CONV_ID);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('not_found');
  });

  it('returns the conversation messages', async () => {
    currentDb = makeDbSeq([
      [{ id: CHAT_CONV_ID }], // conversation verify
      [
        { id: 'm1', role: 'user', content: 'salut' },
        { id: 'm2', role: 'assistant', content: 'Bonjour Quentin !' },
      ],
    ]) as typeof currentDb;

    const { listChatAction } = await import('../src/lib/actions.ts');
    const r = await listChatAction(CHAT_CONV_ID);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.messages).toHaveLength(2);
      expect(r.data.messages[0]).toEqual({ id: 'm1', role: 'user', content: 'salut' });
      expect(r.data.messages[1]!.content).toBe('Bonjour Quentin !');
    }
  });
});

// ─── Security / Auth Settings ────────────────────────────────────────────────

describe('getSecuritySettingsAction', () => {
  it('returns runtime mode + configured mode (config missing → trust default)', async () => {
    cliConfigMocks.read.mockReturnValue(null);
    const { getSecuritySettingsAction } = await import('../src/lib/actions.ts');
    const r = await getSecuritySettingsAction();
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.runtimeMode).toBe('local-trust');
      expect(r.data.configuredMode).toBe('local-trust');
      expect(r.data.googleConfigured).toBe(false);
      expect(r.data.configPathExists).toBe(false);
    }
  });

  it('reads explicit auth.mode from config', async () => {
    cliConfigMocks.read.mockReturnValue({
      bind: 'loopback',
      auth: { mode: 'local-auth', googleClientId: 'cid', googleClientSecret: 'sec' },
    });
    const { getSecuritySettingsAction } = await import('../src/lib/actions.ts');
    const r = await getSecuritySettingsAction();
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.configuredMode).toBe('local-auth');
      expect(r.data.googleConfigured).toBe(true);
      expect(r.data.configPathExists).toBe(true);
    }
  });

  it('falls back to bind-derived default when auth.mode is absent', async () => {
    cliConfigMocks.read.mockReturnValue({ bind: 'lan' });
    const { getSecuritySettingsAction } = await import('../src/lib/actions.ts');
    const r = await getSecuritySettingsAction();
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data.configuredMode).toBe('local-auth');
  });
});

describe('updateAuthSettingsAction', () => {
  it('rejects bad mode', async () => {
    const { updateAuthSettingsAction } = await import('../src/lib/actions.ts');
    const r = await updateAuthSettingsAction({ mode: 'bogus' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('validation_failed');
  });

  it('returns cli_config_missing when config file is absent', async () => {
    cliConfigMocks.read.mockReturnValue(null);
    const { updateAuthSettingsAction } = await import('../src/lib/actions.ts');
    const r = await updateAuthSettingsAction({ mode: 'local-auth' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('cli_config_missing');
  });

  it('writes auth.mode change and reports requiresRestart=true when mode differs from runtime', async () => {
    cliConfigMocks.read.mockReturnValue({ bind: 'loopback', auth: {} });
    cliConfigMocks.merge.mockReset();
    const { updateAuthSettingsAction } = await import('../src/lib/actions.ts');
    const r = await updateAuthSettingsAction({ mode: 'local-auth' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data.requiresRestart).toBe(true);
    expect(cliConfigMocks.merge).toHaveBeenCalledTimes(1);
    const patch = cliConfigMocks.merge.mock.calls[0]![0] as { auth: { mode: string } };
    expect(patch.auth.mode).toBe('local-auth');
  });

  it('preserves existing google fields when only mode changes', async () => {
    cliConfigMocks.read.mockReturnValue({
      bind: 'loopback',
      auth: { mode: 'local-trust', googleClientId: 'cid', googleClientSecret: 'sec' },
    });
    cliConfigMocks.merge.mockReset();
    const { updateAuthSettingsAction } = await import('../src/lib/actions.ts');
    const r = await updateAuthSettingsAction({ mode: 'local-auth' });
    expect(r.ok).toBe(true);
    const patch = cliConfigMocks.merge.mock.calls[0]![0] as {
      auth: { googleClientId?: string; googleClientSecret?: string };
    };
    expect(patch.auth.googleClientId).toBe('cid');
    expect(patch.auth.googleClientSecret).toBe('sec');
  });

  it('clears google fields when clearGoogle=true', async () => {
    cliConfigMocks.read.mockReturnValue({
      bind: 'loopback',
      auth: { mode: 'local-auth', googleClientId: 'cid', googleClientSecret: 'sec' },
    });
    cliConfigMocks.merge.mockReset();
    const { updateAuthSettingsAction } = await import('../src/lib/actions.ts');
    const r = await updateAuthSettingsAction({ mode: 'local-auth', clearGoogle: true });
    expect(r.ok).toBe(true);
    const patch = cliConfigMocks.merge.mock.calls[0]![0] as {
      auth: { googleClientId?: string; googleClientSecret?: string };
    };
    expect(patch.auth.googleClientId).toBeUndefined();
    expect(patch.auth.googleClientSecret).toBeUndefined();
  });

  it('overwrites google fields when new values are provided', async () => {
    cliConfigMocks.read.mockReturnValue({
      bind: 'loopback',
      auth: { mode: 'local-auth', googleClientId: 'old', googleClientSecret: 'old' },
    });
    cliConfigMocks.merge.mockReset();
    const { updateAuthSettingsAction } = await import('../src/lib/actions.ts');
    const r = await updateAuthSettingsAction({
      mode: 'local-auth',
      googleClientId: 'new-id',
      googleClientSecret: 'new-secret',
    });
    expect(r.ok).toBe(true);
    const patch = cliConfigMocks.merge.mock.calls[0]![0] as {
      auth: { googleClientId?: string; googleClientSecret?: string };
    };
    expect(patch.auth.googleClientId).toBe('new-id');
    expect(patch.auth.googleClientSecret).toBe('new-secret');
  });
});

describe('updateNetworkSettingsAction', () => {
  it('rejects bad bind value', async () => {
    const { updateNetworkSettingsAction } = await import('../src/lib/actions.ts');
    const r = await updateNetworkSettingsAction({ bind: 'bogus' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('validation_failed');
  });

  it('writes bind=lan and reports requiresRestart=true when bind differs from runtime', async () => {
    cliConfigMocks.merge.mockReset();
    cliConfigMocks.merge.mockImplementation(() => undefined);
    const { updateNetworkSettingsAction } = await import('../src/lib/actions.ts');
    const r = await updateNetworkSettingsAction({ bind: 'lan' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data.requiresRestart).toBe(true);
    expect(cliConfigMocks.merge).toHaveBeenCalledTimes(1);
    const patch = cliConfigMocks.merge.mock.calls[0]![0] as { bind: string };
    expect(patch.bind).toBe('lan');
  });

  it('writes bind=loopback and reports requiresRestart=false when matching runtime', async () => {
    cliConfigMocks.merge.mockReset();
    cliConfigMocks.merge.mockImplementation(() => undefined);
    const { updateNetworkSettingsAction } = await import('../src/lib/actions.ts');
    const r = await updateNetworkSettingsAction({ bind: 'loopback' });
    expect(r.ok).toBe(true);
    // Test env defaults BIND to 127.0.0.1 (loopback) — see env.ts schema.
    if (r.ok) expect(r.data.requiresRestart).toBe(false);
    const patch = cliConfigMocks.merge.mock.calls[0]![0] as { bind: string };
    expect(patch.bind).toBe('loopback');
  });

  it('returns cli_config_missing when mergeNodalaiConfig signals the file is absent', async () => {
    cliConfigMocks.merge.mockReset();
    cliConfigMocks.merge.mockImplementation(() => {
      throw new Error('cli_config_missing');
    });
    const { updateNetworkSettingsAction } = await import('../src/lib/actions.ts');
    const r = await updateNetworkSettingsAction({ bind: 'lan' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('cli_config_missing');
  });
});

// ─── updateAgentAction ────────────────────────────────────────────────────────

describe('updateAgentAction — validation', () => {
  it('rejects non-uuid id', async () => {
    const { updateAgentAction } = await import('../src/lib/actions.ts');
    const r = await updateAgentAction({
      id: 'not-a-uuid',
      name: 'Test',
      personality: 'Hi',
      model: 'gpt-4',
      role: 'worker',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('validation_failed');
  });

  it('rejects empty name', async () => {
    const { updateAgentAction } = await import('../src/lib/actions.ts');
    const r = await updateAgentAction({
      id: 'aaaaaaaa-0000-0000-0000-000000000001',
      name: '',
      personality: 'Hi',
      model: 'gpt-4',
      role: 'worker',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('validation_failed');
  });

  it('rejects invalid role', async () => {
    const { updateAgentAction } = await import('../src/lib/actions.ts');
    const r = await updateAgentAction({
      id: 'aaaaaaaa-0000-0000-0000-000000000001',
      name: 'Test',
      personality: 'Hi',
      model: 'gpt-4',
      role: 'super-agent',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('validation_failed');
  });

  it('strips slug even if passed in raw payload (slug is not in schema)', async () => {
    // This is a security invariant: slug must be immutable.
    // We verify by confirming that a payload WITH a slug field still parses
    // OK (no validation_failed from slug presence), and then the DB update
    // path does NOT include slug in the set(...) call.
    // Here we mock the DB to return not_found (empty) so the action aborts
    // after schema validation — we just care that validation_failed is NOT
    // the result code.
    currentDb = makeDb([]) as typeof currentDb;
    const { updateAgentAction } = await import('../src/lib/actions.ts');
    const r = await updateAgentAction({
      id: 'aaaaaaaa-0000-0000-0000-000000000001',
      name: 'Renamed',
      personality: 'Hi',
      model: 'gpt-4',
      role: 'worker',
      slug: 'injected-slug', // should be silently stripped by safeParse
    });
    // validation_failed would mean schema rejected the input — that would be
    // wrong. We expect not_found (no agent in mock DB) or ok.
    expect(r.ok === false && (r as { code: string }).code === 'validation_failed').toBe(false);
  });
});

describe('updateAgentAction — db path', () => {
  it('returns not_found when agent does not belong to entity', async () => {
    currentDb = makeDb([]) as typeof currentDb; // ownership select returns empty
    const { updateAgentAction } = await import('../src/lib/actions.ts');
    const r = await updateAgentAction({
      id: 'aaaaaaaa-0000-0000-0000-000000000001',
      name: 'Test',
      personality: 'Hi',
      model: 'gpt-4',
      role: 'worker',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('not_found');
  });

  it('happy path — UPDATE receives correct fields for worker role', async () => {
    // The chain mock returns the same rows for every awaited query.
    // One row with id is enough: satisfies the ownership select AND the
    // update/delete/update chains (they don't inspect the row).
    currentDb = makeDb([{ id: 'aaaaaaaa-0000-0000-0000-000000000001' }]) as typeof currentDb;
    const { updateAgentAction } = await import('../src/lib/actions.ts');
    const r = await updateAgentAction({
      id: 'aaaaaaaa-0000-0000-0000-000000000001',
      name: 'New Name',
      personality: 'Updated personality.',
      model: 'claude-sonnet-4-6',
      role: 'worker',
    });
    expect(r.ok).toBe(true);

    const updateSpy = (currentDb as unknown as { update: ReturnType<typeof vi.fn> }).update;
    // First update call is the agents table SET
    const setCalls = updateSpy.mock.results
      .map((res) => (res.value as { set?: ReturnType<typeof vi.fn> }).set)
      .filter(Boolean);
    const firstSet = setCalls[0];
    expect(firstSet).toBeDefined();
    const firstSetArg = (firstSet as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as
      | Record<string, unknown>
      | undefined;
    expect(firstSetArg?.['name']).toBe('New Name');
    expect(firstSetArg?.['personality']).toBe('Updated personality.');
    expect(firstSetArg?.['role']).toBe('agent');
    expect(firstSetArg?.['orchestratorMode']).toBe(null);
    // slug must NOT appear in the update payload
    expect(firstSetArg?.['slug']).toBeUndefined();
  });

  it('maps router role to orchestrator + orchestratorMode=router', async () => {
    currentDb = makeDb([{ id: 'aaaaaaaa-0000-0000-0000-000000000002' }]) as typeof currentDb;
    const { updateAgentAction } = await import('../src/lib/actions.ts');
    const r = await updateAgentAction({
      id: 'aaaaaaaa-0000-0000-0000-000000000002',
      name: 'Router Agent',
      personality: 'I route.',
      model: 'gpt-4',
      role: 'router',
      subAgentIds: [],
    });
    expect(r.ok).toBe(true);

    const updateSpy = (currentDb as unknown as { update: ReturnType<typeof vi.fn> }).update;
    const setCalls = updateSpy.mock.results
      .map((res) => (res.value as { set?: ReturnType<typeof vi.fn> }).set)
      .filter(Boolean);
    const firstSetArg = (setCalls[0] as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as
      | Record<string, unknown>
      | undefined;
    expect(firstSetArg?.['role']).toBe('orchestrator');
    expect(firstSetArg?.['orchestratorMode']).toBe('router');
  });

  it('re-inserts sub-agent assignments for router with subAgentIds', async () => {
    const subId = '22222222-2222-2222-2222-222222222222';
    // Sequenced, not the dumb shared-array `makeDb`: updateAgentAction now
    // issues TWO selects (ownership, then the FIX #3 entity check on
    // subAgentIds) and `makeDb` would hand the SAME 1-row array to both,
    // making this test pass by row-count coincidence (1 subAgentId === 1
    // shared row) rather than because the subAgentId was actually found.
    // With 2 subAgentIds that coincidence breaks — makeDbSeq sequences each
    // select explicitly so the test is green for the right reason.
    currentDb = makeDbSeq([
      [{ id: 'aaaaaaaa-0000-0000-0000-000000000003' }], // ownership check
      [{ id: subId }], // subAgentIds entity check: subId IS found
    ]) as typeof currentDb;
    const { updateAgentAction } = await import('../src/lib/actions.ts');
    const r = await updateAgentAction({
      id: 'aaaaaaaa-0000-0000-0000-000000000003',
      name: 'Router',
      personality: 'I route.',
      model: 'gpt-4',
      role: 'router',
      subAgentIds: [subId],
    });
    expect(r.ok).toBe(true);

    const insertSpy = (currentDb as unknown as { insert: ReturnType<typeof vi.fn> }).insert;
    const deleteSpy = (currentDb as unknown as { delete: ReturnType<typeof vi.fn> }).delete;

    // DELETE must have been called (clear old assignments)
    expect(deleteSpy.mock.calls.length).toBeGreaterThanOrEqual(1);

    // INSERT must have been called with the new sub-agent row
    const valuesCalls = insertSpy.mock.results
      .flatMap((res) => (res.value as { values?: ReturnType<typeof vi.fn> }).values?.mock?.calls)
      .filter(Boolean) as unknown[][];
    const assignmentValues = valuesCalls[0]?.[0] as Array<Record<string, unknown>> | undefined;
    expect(Array.isArray(assignmentValues)).toBe(true);
    expect(assignmentValues?.[0]?.['subAgentId']).toBe(subId);
  });

  it('system_prompt cache invalidation — UPDATE agentJobs with systemPrompt=null for active jobs', async () => {
    currentDb = makeDb([{ id: 'aaaaaaaa-0000-0000-0000-000000000004' }]) as typeof currentDb;
    const { updateAgentAction } = await import('../src/lib/actions.ts');
    const r = await updateAgentAction({
      id: 'aaaaaaaa-0000-0000-0000-000000000004',
      name: 'Agent',
      personality: 'New personality.',
      model: 'gpt-4',
      role: 'worker',
    });
    expect(r.ok).toBe(true);

    const updateSpy = (currentDb as unknown as { update: ReturnType<typeof vi.fn> }).update;
    // There should be at least 2 update calls: agents table + agentJobs table
    expect(updateSpy.mock.calls.length).toBeGreaterThanOrEqual(2);

    // The chain mock returns the SAME set fn across all .update() calls, so
    // iterate ALL set call args (not just [0] per result) to find the agentJobs
    // update — identified by the presence of `systemPrompt` in its set payload.
    const sharedSet = (updateSpy.mock.results[0]?.value as { set?: ReturnType<typeof vi.fn> })?.set;
    expect(sharedSet).toBeDefined();
    const allSetArgs = sharedSet!.mock.calls.map(
      (args) => args[0] as Record<string, unknown> | undefined,
    );
    const jobsSetArg = allSetArgs.find((arg) => arg !== undefined && 'systemPrompt' in arg);

    expect(jobsSetArg).toBeDefined();
    expect(jobsSetArg?.['systemPrompt']).toBe(null);
  });

  it('rejects subAgentIds not fully found in the caller entity (cross-tenant or nonexistent) — sub_agents_not_found', async () => {
    // Mirrors createAgentRepo's entity check (packages/db/src/repos/agents.ts:
    // 57-65), which the edit path skipped: attaching another tenant's agent as
    // a sub-agent would let it execute under this orchestrator (its config,
    // its skills, its LLM key). The sequential mock returns a row for the
    // ownership check, then an EMPTY row for the entity-scoped subAgentIds
    // check — simulating a foreign/nonexistent id.
    const foreignSubId = '33333333-3333-3333-3333-333333333333';
    currentDb = makeDbSeq([
      [{ id: 'aaaaaaaa-0000-0000-0000-000000000005' }], // ownership check: agent exists
      [], // subAgentIds entity check: nothing found
    ]) as typeof currentDb;
    const { updateAgentAction } = await import('../src/lib/actions.ts');
    const r = await updateAgentAction({
      id: 'aaaaaaaa-0000-0000-0000-000000000005',
      name: 'Router',
      personality: 'I route.',
      model: 'gpt-4',
      role: 'router',
      subAgentIds: [foreignSubId],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('validation_failed');

    // The request was rejected up front — no assignment was ever written.
    const insertSpy = (currentDb as unknown as { insert: ReturnType<typeof vi.fn> }).insert;
    expect(insertSpy).not.toHaveBeenCalled();
  });

  it('accepts subAgentIds that ARE all in the caller entity — writes the assignment', async () => {
    const subId = '44444444-4444-4444-4444-444444444444';
    currentDb = makeDbSeq([
      [{ id: 'aaaaaaaa-0000-0000-0000-000000000006' }], // ownership check
      [{ id: subId }], // subAgentIds entity check: found
    ]) as typeof currentDb;
    const { updateAgentAction } = await import('../src/lib/actions.ts');
    const r = await updateAgentAction({
      id: 'aaaaaaaa-0000-0000-0000-000000000006',
      name: 'Router',
      personality: 'I route.',
      model: 'gpt-4',
      role: 'router',
      subAgentIds: [subId],
    });
    expect(r.ok).toBe(true);

    const insertSpy = (currentDb as unknown as { insert: ReturnType<typeof vi.fn> }).insert;
    expect(insertSpy).toHaveBeenCalled();

    // Stronger proof (invariant #5): the actual payload written carries the
    // validated subId, not just "insert happened".
    const valuesCalls = insertSpy.mock.results
      .flatMap((res) => (res.value as { values?: ReturnType<typeof vi.fn> }).values?.mock?.calls)
      .filter(Boolean) as unknown[][];
    const assignmentValues = valuesCalls[0]?.[0] as Array<Record<string, unknown>> | undefined;
    expect(Array.isArray(assignmentValues)).toBe(true);
    expect(assignmentValues?.[0]?.['subAgentId']).toBe(subId);
  });
});

// ─── sendTaskAction — Telegram delivery channel ────────────────────────────────
// These tests need sequential db.select() calls to return different rows, so we
// build a small helper that returns a different chain for each call to select().

function chainOnce(rows: unknown[]): unknown {
  const p = Promise.resolve(rows);
  const c: Record<string, unknown> = {
    then: (onFulfilled: (v: unknown) => unknown, onRejected: (e: unknown) => unknown) =>
      p.then(onFulfilled, onRejected),
    catch: (onRejected: (e: unknown) => unknown) => p.catch(onRejected),
    finally: (onFinally: () => unknown) => p.finally(onFinally),
  };
  for (const m of [
    'from',
    'where',
    'orderBy',
    'limit',
    'values',
    'returning',
    'set',
    'onConflictDoNothing',
    'leftJoin',
    'innerJoin',
    'rightJoin',
    'fullJoin',
    'groupBy',
    'having',
    'offset',
  ]) {
    c[m] = vi.fn().mockReturnValue(c);
  }
  return c;
}

/** Build a db where select() returns rows from `selectSequence` in order. */
function makeDbSeq(selectSequence: unknown[][], insertRows: unknown[] = []) {
  let callIndex = 0;
  const insertChain = chainOnce(insertRows);
  const db = {
    select: vi.fn().mockImplementation(() => {
      const rows = selectSequence[callIndex] ?? [];
      callIndex += 1;
      return chainOnce(rows);
    }),
    insert: vi.fn().mockReturnValue(insertChain),
    delete: vi.fn().mockReturnValue(chainOnce([])),
    update: vi.fn().mockReturnValue(chainOnce([])),
    transaction: vi.fn((cb: (tx: unknown) => unknown) => cb(db)),
  };
  return db;
}

const AGENT_UUID = 'aaaaaaaa-1111-1111-1111-111111111111';

describe('sendTaskAction — Telegram delivery channel', () => {
  it('returns no_telegram_recipient_known when sendViaTelegram=true and lastSeenChatIdTelegram is null', async () => {
    currentDb = makeDbSeq(
      [
        [{ id: AGENT_UUID, slug: 'test-agent' }], // ownership check
        [{ chatId: null }], // lastSeenChatIdTelegram lookup
      ],
      [],
    ) as typeof currentDb;

    const { sendTaskAction } = await import('../src/lib/actions.ts');
    const r = await sendTaskAction({
      prompt: 'Do something',
      agentId: AGENT_UUID,
      sendViaTelegram: 'true',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('no_telegram_recipient_known');

    // No insert should have happened
    const insertSpy = (currentDb as unknown as { insert: ReturnType<typeof vi.fn> }).insert;
    expect(insertSpy).not.toHaveBeenCalled();
  });

  it('sets chatId on job row when sendViaTelegram=true and lastSeenChatIdTelegram is populated (Brique 31: no suffix injection)', async () => {
    currentDb = makeDbSeq(
      [
        [{ id: AGENT_UUID, slug: 'test-agent' }], // ownership check
        [{ chatId: '12345' }], // lastSeenChatIdTelegram lookup
      ],
      [{ id: 'jobid-1111-1111-1111-111111111111' }], // insert returning
    ) as typeof currentDb;

    const { sendTaskAction } = await import('../src/lib/actions.ts');
    const r = await sendTaskAction({
      prompt: 'Do something',
      agentId: AGENT_UUID,
      sendViaTelegram: 'true',
    });
    expect(r.ok).toBe(true);

    // Assert on the values passed to insert().values()
    const insertSpy = (currentDb as unknown as { insert: ReturnType<typeof vi.fn> }).insert;
    const valuesCalls = insertSpy.mock.results
      .flatMap((res) => (res.value as { values?: ReturnType<typeof vi.fn> }).values?.mock?.calls)
      .filter(Boolean) as unknown[][];
    const jobValues = valuesCalls[0]?.[0] as Record<string, unknown> | undefined;

    // Brique 31: task is pure user prompt — no suffix injection
    expect(jobValues?.['task']).toBe('Do something');
    expect(jobValues?.['task'] as string).not.toContain('## Delivery channels');
    // chatId is set on the job row (runner will build Job context block in system_prompt)
    expect(jobValues?.['chatId']).toBe('12345');
    expect(jobValues?.['channel']).toBe('api');
  });

  it('does NOT set chatId and task is pure prompt when sendViaTelegram is absent (regression)', async () => {
    currentDb = makeDbSeq(
      [
        [{ id: AGENT_UUID, slug: 'test-agent' }], // ownership check only (no TG lookup)
      ],
      [{ id: 'jobid-2222-2222-2222-222222222222' }],
    ) as typeof currentDb;

    const { sendTaskAction } = await import('../src/lib/actions.ts');
    const r = await sendTaskAction({
      prompt: 'Plain prompt',
      agentId: AGENT_UUID,
    });
    expect(r.ok).toBe(true);

    const insertSpy = (currentDb as unknown as { insert: ReturnType<typeof vi.fn> }).insert;
    const valuesCalls = insertSpy.mock.results
      .flatMap((res) => (res.value as { values?: ReturnType<typeof vi.fn> }).values?.mock?.calls)
      .filter(Boolean) as unknown[][];
    const jobValues = valuesCalls[0]?.[0] as Record<string, unknown> | undefined;

    // task is pure prompt, no suffix, no chatId
    expect(jobValues?.['task']).toBe('Plain prompt');
    expect(jobValues?.['task'] as string).not.toContain('## Delivery channels');
    // chatId not set (key absent or undefined — no spread)
    expect(jobValues?.['chatId']).toBeUndefined();
    expect(jobValues?.['channel']).toBe('api');
  });

  it('returns not_found when sendViaTelegram=true but agent belongs to a different entity', async () => {
    // First select returns [] → agent not found under entity
    currentDb = makeDbSeq(
      [
        [], // ownership check: empty → not found
      ],
      [],
    ) as typeof currentDb;

    const { sendTaskAction } = await import('../src/lib/actions.ts');
    const r = await sendTaskAction({
      prompt: 'Do something',
      agentId: AGENT_UUID,
      sendViaTelegram: 'true',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('not_found');
  });
});

// ─── updateSkillAction ────────────────────────────────────────────────────────

describe('updateSkillAction — validation', () => {
  it('rejects non-uuid id', async () => {
    const { updateSkillAction } = await import('../src/lib/actions.ts');
    const r = await updateSkillAction({
      id: 'not-a-uuid',
      name: 'Test',
      content: 'Some instructions',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('validation_failed');
  });

  it('rejects empty name', async () => {
    const { updateSkillAction } = await import('../src/lib/actions.ts');
    const r = await updateSkillAction({
      id: 'aaaaaaaa-0000-0000-0000-000000000001',
      name: '',
      content: 'Some instructions',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('validation_failed');
  });

  it('rejects empty content', async () => {
    const { updateSkillAction } = await import('../src/lib/actions.ts');
    const r = await updateSkillAction({
      id: 'aaaaaaaa-0000-0000-0000-000000000001',
      name: 'My Skill',
      content: '',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('validation_failed');
  });

  it('strips slug even if passed in raw payload (slug is not in schema)', async () => {
    // Security invariant: slug must be immutable.
    // Verify that a payload WITH a slug field still passes schema validation
    // (not validation_failed), then aborts at not_found since mock DB is empty.
    currentDb = makeDb([]) as typeof currentDb;
    const { updateSkillAction } = await import('../src/lib/actions.ts');
    const r = await updateSkillAction({
      id: 'aaaaaaaa-0000-0000-0000-000000000001',
      name: 'Renamed',
      content: 'Some instructions',
      slug: 'injected-slug', // should be silently stripped by safeParse
    });
    // validation_failed would mean schema rejected the slug field — that's wrong.
    // We expect not_found (no skill in mock DB).
    expect(r.ok === false && (r as { code: string }).code === 'validation_failed').toBe(false);
  });
});

describe('updateSkillAction — db path', () => {
  it('returns not_found when skill does not belong to entity', async () => {
    currentDb = makeDb([]) as typeof currentDb; // ownership select returns empty
    const { updateSkillAction } = await import('../src/lib/actions.ts');
    const r = await updateSkillAction({
      id: 'aaaaaaaa-0000-0000-0000-000000000001',
      name: 'Test',
      content: 'Some instructions',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('not_found');
  });

  it('happy path — UPDATE receives correct fields', async () => {
    currentDb = makeDb([{ id: 'aaaaaaaa-0000-0000-0000-000000000001' }]) as typeof currentDb;
    const { updateSkillAction } = await import('../src/lib/actions.ts');
    const r = await updateSkillAction({
      id: 'aaaaaaaa-0000-0000-0000-000000000001',
      name: 'New Skill Name',
      content: 'Updated instructions.',
      description: 'A short description',
    });
    expect(r.ok).toBe(true);

    const updateSpy = (currentDb as unknown as { update: ReturnType<typeof vi.fn> }).update;
    const setCalls = updateSpy.mock.results
      .map((res) => (res.value as { set?: ReturnType<typeof vi.fn> }).set)
      .filter(Boolean);
    const firstSet = setCalls[0];
    expect(firstSet).toBeDefined();
    const firstSetArg = (firstSet as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as
      | Record<string, unknown>
      | undefined;
    expect(firstSetArg?.['name']).toBe('New Skill Name');
    expect(firstSetArg?.['content']).toBe('Updated instructions.');
    expect(firstSetArg?.['description']).toBe('A short description');
    // slug must NOT appear in the update payload
    expect(firstSetArg?.['slug']).toBeUndefined();
  });

  it('slug NOT changed — schema does not accept slug field', async () => {
    currentDb = makeDb([{ id: 'aaaaaaaa-0000-0000-0000-000000000002' }]) as typeof currentDb;
    const { updateSkillAction } = await import('../src/lib/actions.ts');
    const r = await updateSkillAction({
      id: 'aaaaaaaa-0000-0000-0000-000000000002',
      name: 'Renamed Skill',
      content: 'New content.',
      slug: 'attempted-slug-change',
    });
    expect(r.ok).toBe(true);

    const updateSpy = (currentDb as unknown as { update: ReturnType<typeof vi.fn> }).update;
    const setCalls = updateSpy.mock.results
      .map((res) => (res.value as { set?: ReturnType<typeof vi.fn> }).set)
      .filter(Boolean);
    const setArg = (setCalls[0] as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as
      | Record<string, unknown>
      | undefined;
    // Slug must not be present in the SET payload at all
    expect(setArg?.['slug']).toBeUndefined();
  });
});

describe('updateSkillAction — contentOverridden flag', () => {
  it('flips contentOverridden=true when content differs from current row', async () => {
    currentDb = makeDb([
      { id: 'aaaaaaaa-0000-0000-0000-0000000002a1', content: 'Old content' },
    ]) as typeof currentDb;
    const { updateSkillAction } = await import('../src/lib/actions.ts');
    const r = await updateSkillAction({
      id: 'aaaaaaaa-0000-0000-0000-0000000002a1',
      name: 'Same Name',
      content: 'Brand new content',
    });
    expect(r.ok).toBe(true);

    const updateSpy = (currentDb as unknown as { update: ReturnType<typeof vi.fn> }).update;
    const firstSet = (updateSpy.mock.results[0]?.value as { set?: ReturnType<typeof vi.fn> }).set;
    const firstSetArg = firstSet?.mock.calls[0]?.[0] as Record<string, unknown> | undefined;
    expect(firstSetArg?.['contentOverridden']).toBe(true);
  });

  it('does NOT include contentOverridden in the patch when content is unchanged', async () => {
    currentDb = makeDb([
      { id: 'aaaaaaaa-0000-0000-0000-0000000002a2', content: 'Same content' },
    ]) as typeof currentDb;
    const { updateSkillAction } = await import('../src/lib/actions.ts');
    const r = await updateSkillAction({
      id: 'aaaaaaaa-0000-0000-0000-0000000002a2',
      name: 'Renamed only',
      content: 'Same content',
    });
    expect(r.ok).toBe(true);

    const updateSpy = (currentDb as unknown as { update: ReturnType<typeof vi.fn> }).update;
    const firstSet = (updateSpy.mock.results[0]?.value as { set?: ReturnType<typeof vi.fn> }).set;
    const firstSetArg = firstSet?.mock.calls[0]?.[0] as Record<string, unknown> | undefined;
    expect('contentOverridden' in (firstSetArg ?? {})).toBe(false);
  });
});

describe('resetSkillToDefaultAction', () => {
  it('returns validation_failed on non-uuid id', async () => {
    const { resetSkillToDefaultAction } = await import('../src/lib/actions.ts');
    const r = await resetSkillToDefaultAction('not-a-uuid');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('validation_failed');
  });

  it('returns not_found when skill does not belong to entity', async () => {
    currentDb = makeDb([]) as typeof currentDb;
    const { resetSkillToDefaultAction } = await import('../src/lib/actions.ts');
    const r = await resetSkillToDefaultAction('aaaaaaaa-0000-0000-0000-0000000002a3');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('not_found');
  });

  it('returns not_applicable when defaultContent is null (user-created skill)', async () => {
    currentDb = makeDb([
      { id: 'aaaaaaaa-0000-0000-0000-0000000002a4', defaultContent: null },
    ]) as typeof currentDb;
    const { resetSkillToDefaultAction } = await import('../src/lib/actions.ts');
    const r = await resetSkillToDefaultAction('aaaaaaaa-0000-0000-0000-0000000002a4');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('not_applicable');
  });

  it('happy path — writes defaultContent back to content and clears the flag', async () => {
    const defaultContent = 'Canonical skill body';
    currentDb = makeDb([
      { id: 'aaaaaaaa-0000-0000-0000-0000000002a5', defaultContent },
    ]) as typeof currentDb;
    const { resetSkillToDefaultAction } = await import('../src/lib/actions.ts');
    const r = await resetSkillToDefaultAction('aaaaaaaa-0000-0000-0000-0000000002a5');
    expect(r.ok).toBe(true);

    const updateSpy = (currentDb as unknown as { update: ReturnType<typeof vi.fn> }).update;
    const setFn = (updateSpy.mock.results[0]?.value as { set?: ReturnType<typeof vi.fn> }).set;
    const setArg = setFn?.mock.calls[0]?.[0] as Record<string, unknown> | undefined;
    expect(setArg?.['content']).toBe(defaultContent);
    expect(setArg?.['contentOverridden']).toBe(false);
  });
});

// ─── MCP connector actions ────────────────────────────────────────────────────

function mockMcpConnection(tools: Array<{ name: string; description?: string }>) {
  return {
    client: {
      callTool: vi.fn().mockResolvedValue({ content: [], isError: false }),
    },
    tools,
    close: vi.fn().mockResolvedValue(undefined),
  };
}

describe('createMcpServerFromCatalogAction', () => {
  it('rejects an API key without the catalog key prefix — no connect, no row', async () => {
    mcpAdapterMocks.connectMcp.mockClear();
    currentDb = makeDb([]) as typeof currentDb;
    const { createMcpServerFromCatalogAction } = await import('../src/lib/actions.ts');
    const r = await createMcpServerFromCatalogAction({
      slug: 'cogni-cortex',
      name: 'My Cortex',
      apiKey: 'wrong_prefix_key',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('validation_failed');
    expect(mcpAdapterMocks.connectMcp).not.toHaveBeenCalled();
    expect(
      (currentDb as unknown as { insert: ReturnType<typeof vi.fn> }).insert,
    ).not.toHaveBeenCalled();
  });

  it('rejects an unknown catalog slug', async () => {
    const { createMcpServerFromCatalogAction } = await import('../src/lib/actions.ts');
    const r = await createMcpServerFromCatalogAction({
      slug: 'no-such',
      name: 'X',
      apiKey: 'cog_x',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('validation_failed');
  });

  it('fails loud and writes NO row when the MCP connection fails', async () => {
    mcpAdapterMocks.connectMcp.mockReset();
    mcpAdapterMocks.connectMcp.mockRejectedValue(new Error('401 Unauthorized'));
    currentDb = makeDb([]) as typeof currentDb;
    const { createMcpServerFromCatalogAction } = await import('../src/lib/actions.ts');
    const r = await createMcpServerFromCatalogAction({
      slug: 'cogni-cortex',
      name: 'My Cortex',
      apiKey: 'cog_badkey',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('mcp_connect_failed');
    expect(
      (currentDb as unknown as { insert: ReturnType<typeof vi.fn> }).insert,
    ).not.toHaveBeenCalled();
  });

  it('fails loud when the verify tool returns isError — no row', async () => {
    mcpAdapterMocks.connectMcp.mockReset();
    const conn = mockMcpConnection([{ name: 'get_home' }]);
    conn.client.callTool.mockResolvedValue({ content: [], isError: true });
    mcpAdapterMocks.connectMcp.mockResolvedValue(conn);
    currentDb = makeDb([]) as typeof currentDb;
    const { createMcpServerFromCatalogAction } = await import('../src/lib/actions.ts');
    const r = await createMcpServerFromCatalogAction({
      slug: 'cogni-cortex',
      name: 'My Cortex',
      apiKey: 'cog_badkey',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('mcp_connect_failed');
    expect(
      (currentDb as unknown as { insert: ReturnType<typeof vi.fn> }).insert,
    ).not.toHaveBeenCalled();
    expect(conn.close).toHaveBeenCalled();
  });

  it('happy path — encrypts the key, caches discovered tools, inserts the row', async () => {
    mcpAdapterMocks.connectMcp.mockReset();
    mcpAdapterMocks.connectMcp.mockResolvedValue(
      mockMcpConnection([{ name: 'get_home', description: 'home view' }, { name: 'get_feed' }]),
    );
    currentDb = makeDb([{ id: 'aaaaaaaa-0000-0000-0000-0000000003a1' }]) as typeof currentDb;
    const { createMcpServerFromCatalogAction } = await import('../src/lib/actions.ts');
    const r = await createMcpServerFromCatalogAction({
      slug: 'cogni-cortex',
      name: 'My Cortex',
      apiKey: 'cog_testkey123',
    });
    expect(r.ok).toBe(true);

    const insertSpy = (currentDb as unknown as { insert: ReturnType<typeof vi.fn> }).insert;
    const valuesFn = (insertSpy.mock.results[0]?.value as { values?: ReturnType<typeof vi.fn> })
      .values;
    const values = valuesFn?.mock.calls[0]?.[0] as Record<string, unknown> | undefined;
    expect(values).toBeDefined();
    // The stored key is encrypted, never plaintext.
    expect(isEncrypted(values?.['apiKey'] as string)).toBe(true);
    expect(values?.['apiKey']).not.toBe('cog_testkey123');
    expect(values?.['apiKeyLast4']).toBe('y123');
    expect(values?.['authScheme']).toBe('header');
    expect(values?.['authParamName']).toBe('x-api-key');
    // Discovered tools are cached for the UI.
    expect(values?.['availableTools']).toEqual([
      { name: 'get_home', description: 'home view' },
      { name: 'get_feed', description: null },
    ]);
  });

  // ── Custom HTTP MCP ───────────────────────────────────────────────────────
  // The catalog has reserved sentinel slugs (`custom-http-mcp`,
  // `custom-stdio-mcp`) that let the user bring everything themselves.
  // The action substitutes user fields for catalog placeholders before
  // connecting; the persisted row uses the user slug, not the sentinel.

  it('custom-http-mcp — substitutes user slug + auth into the persisted row', async () => {
    mcpAdapterMocks.connectMcp.mockReset();
    mcpAdapterMocks.connectMcp.mockResolvedValue(mockMcpConnection([{ name: 'list_things' }]));
    // SELECT (uniqueness) returns empty; INSERT returning yields the new id.
    currentDb = makeDbMixed({
      select: [],
      insert: [{ id: 'aaaaaaaa-0000-0000-0000-0000000003a2' }],
    }) as typeof currentDb;
    const { createMcpServerFromCatalogAction } = await import('../src/lib/actions.ts');
    const r = await createMcpServerFromCatalogAction({
      slug: 'custom-http-mcp',
      name: 'My API',
      apiKey: 'whatever',
      url: 'https://api.example.com/mcp',
      customSlug: 'my-api',
      customAuthScheme: 'header',
      customAuthParamName: 'x-custom-key',
    });
    expect(r.ok).toBe(true);
    expect(mcpAdapterMocks.connectMcp).toHaveBeenCalledOnce();
    const connectArg = mcpAdapterMocks.connectMcp.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(connectArg['transport']).toBe('http');
    expect(connectArg['url']).toBe('https://api.example.com/mcp');
    expect(connectArg['authScheme']).toBe('header');
    expect(connectArg['authParamName']).toBe('x-custom-key');

    const insertSpy = (currentDb as unknown as { insert: ReturnType<typeof vi.fn> }).insert;
    const valuesFn = (insertSpy.mock.results[0]?.value as { values?: ReturnType<typeof vi.fn> })
      .values;
    const values = valuesFn?.mock.calls[0]?.[0] as Record<string, unknown> | undefined;
    // The user slug — NOT the sentinel — drives the tool-name prefix.
    expect(values?.['slug']).toBe('my-api');
    expect(values?.['authScheme']).toBe('header');
    expect(values?.['authParamName']).toBe('x-custom-key');
  });

  it('custom-http-mcp with bearer — authParamName not required from user', async () => {
    mcpAdapterMocks.connectMcp.mockReset();
    mcpAdapterMocks.connectMcp.mockResolvedValue(mockMcpConnection([]));
    currentDb = makeDbMixed({
      select: [],
      insert: [{ id: 'aaaaaaaa-0000-0000-0000-0000000003a3' }],
    }) as typeof currentDb;
    const { createMcpServerFromCatalogAction } = await import('../src/lib/actions.ts');
    const r = await createMcpServerFromCatalogAction({
      slug: 'custom-http-mcp',
      name: 'Bearer API',
      apiKey: 'tok',
      url: 'https://b.example.com/mcp',
      customSlug: 'bearer-api',
      customAuthScheme: 'bearer',
      // customAuthParamName intentionally omitted — bearer hardcodes Authorization
    });
    expect(r.ok).toBe(true);
  });

  it('custom-http-mcp — refuses an invalid slug shape', async () => {
    mcpAdapterMocks.connectMcp.mockReset();
    currentDb = makeDb([]) as typeof currentDb;
    const { createMcpServerFromCatalogAction } = await import('../src/lib/actions.ts');
    const r = await createMcpServerFromCatalogAction({
      slug: 'custom-http-mcp',
      name: 'X',
      apiKey: 'k',
      url: 'https://x.example.com',
      customSlug: 'Bad Slug!', // uppercase + space — must reject
      customAuthScheme: 'bearer',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('validation_failed');
    expect(mcpAdapterMocks.connectMcp).not.toHaveBeenCalled();
  });

  it('custom-http-mcp — refuses a slug already taken in this entity', async () => {
    mcpAdapterMocks.connectMcp.mockReset();
    // The uniqueness SELECT returns a row → slug taken.
    currentDb = makeDb([{ id: 'aaaaaaaa-0000-0000-0000-0000000003b9' }]) as typeof currentDb;
    const { createMcpServerFromCatalogAction } = await import('../src/lib/actions.ts');
    const r = await createMcpServerFromCatalogAction({
      slug: 'custom-http-mcp',
      name: 'Dup',
      apiKey: 'k',
      url: 'https://x.example.com',
      customSlug: 'my-api',
      customAuthScheme: 'bearer',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('slug_taken');
    expect(mcpAdapterMocks.connectMcp).not.toHaveBeenCalled();
  });

  // ── Custom stdio MCP ──────────────────────────────────────────────────────

  it('custom-stdio-mcp — spawns the subprocess, encrypts env values, persists transport=stdio', async () => {
    mcpAdapterMocks.connectMcp.mockReset();
    mcpAdapterMocks.connectMcp.mockResolvedValue(
      mockMcpConnection([{ name: 'read_file', description: 'read a file' }]),
    );
    currentDb = makeDbMixed({
      select: [],
      insert: [{ id: 'aaaaaaaa-0000-0000-0000-0000000003a4' }],
    }) as typeof currentDb;
    const { createMcpServerFromCatalogAction } = await import('../src/lib/actions.ts');
    const r = await createMcpServerFromCatalogAction({
      slug: 'custom-stdio-mcp',
      name: 'Filesystem',
      customSlug: 'fs',
      customCommand: 'npx',
      customArgs: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'],
      customEnv: { GITHUB_TOKEN: 'ghp_secret_value' },
    });
    expect(r.ok).toBe(true);

    // The connect was invoked with raw env values (decryption happens at
    // job time, encryption happens AFTER the verify connect).
    const connectArg = mcpAdapterMocks.connectMcp.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(connectArg['transport']).toBe('stdio');
    expect(connectArg['command']).toBe('npx');
    expect(connectArg['args']).toEqual(['-y', '@modelcontextprotocol/server-filesystem', '/tmp']);
    expect(connectArg['env']).toEqual({ GITHUB_TOKEN: 'ghp_secret_value' });

    // The persisted row has stdio transport + encrypted env values.
    const insertSpy = (currentDb as unknown as { insert: ReturnType<typeof vi.fn> }).insert;
    const valuesFn = (insertSpy.mock.results[0]?.value as { values?: ReturnType<typeof vi.fn> })
      .values;
    const values = valuesFn?.mock.calls[0]?.[0] as Record<string, unknown> | undefined;
    expect(values?.['slug']).toBe('fs');
    expect(values?.['transport']).toBe('stdio');
    expect(values?.['command']).toBe('npx');
    expect(values?.['url']).toBeNull();
    expect(values?.['apiKey']).toBeNull();
    expect(values?.['authScheme']).toBeNull();
    const envVars = values?.['envVars'] as Record<string, string>;
    expect(envVars).toBeDefined();
    // Env value is encrypted, not plaintext.
    expect(isEncrypted(envVars['GITHUB_TOKEN']!)).toBe(true);
    expect(envVars['GITHUB_TOKEN']).not.toBe('ghp_secret_value');
  });

  it('custom-stdio-mcp — refuses missing command', async () => {
    currentDb = makeDb([]) as typeof currentDb;
    const { createMcpServerFromCatalogAction } = await import('../src/lib/actions.ts');
    const r = await createMcpServerFromCatalogAction({
      slug: 'custom-stdio-mcp',
      name: 'Bad',
      customSlug: 'bad',
      // customCommand intentionally omitted
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('validation_failed');
  });
});

describe('getMcpServerConfigAction', () => {
  it('returns structural config + env KEYS but NEVER secret values', async () => {
    const secret = 'super-secret-token-value';
    const encVal = encrypt(secret);
    currentDb = makeDb([
      {
        id: 'aaaaaaaa-0000-0000-0000-0000000005a1',
        name: 'My FS',
        slug: 'fs',
        transport: 'stdio',
        url: null,
        authScheme: null,
        authParamName: null,
        command: 'npx',
        args: ['-y', 'server-filesystem', '/tmp'],
        envVars: { GITHUB_TOKEN: encVal },
        apiKey: null,
        apiKeyLast4: null,
      },
    ]) as typeof currentDb;
    const { getMcpServerConfigAction } = await import('../src/lib/actions.ts');
    const r = await getMcpServerConfigAction('aaaaaaaa-0000-0000-0000-0000000005a1');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.transport).toBe('stdio');
    expect(r.data.command).toBe('npx');
    expect(r.data.args).toEqual(['-y', 'server-filesystem', '/tmp']);
    expect(r.data.envKeys).toEqual(['GITHUB_TOKEN']);
    // The plaintext AND ciphertext of the secret must never reach the client.
    const serialized = JSON.stringify(r.data);
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain(encVal);
  });

  it('returns not_found for a server outside the entity', async () => {
    currentDb = makeDb([]) as typeof currentDb;
    const { getMcpServerConfigAction } = await import('../src/lib/actions.ts');
    const r = await getMcpServerConfigAction('aaaaaaaa-0000-0000-0000-0000000005a2');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('not_found');
  });
});

describe('updateMcpServerConfigAction', () => {
  function setPayload() {
    const updateSpy = (currentDb as unknown as { update: ReturnType<typeof vi.fn> }).update;
    const setFn = (updateSpy.mock.results[0]?.value as { set?: ReturnType<typeof vi.fn> }).set;
    return setFn?.mock.calls[0]?.[0] as Record<string, unknown> | undefined;
  }

  it('stdio: blank env value KEEPS the stored ciphertext, but verifies with the decrypted plaintext', async () => {
    const encOld = encrypt('stored-token');
    currentDb = makeDb([
      {
        id: 'aaaaaaaa-0000-0000-0000-0000000005b1',
        name: 'FS',
        slug: 'fs',
        transport: 'stdio',
        url: null,
        authScheme: null,
        authParamName: null,
        command: 'npx',
        args: ['-y', 'old-pkg'],
        envVars: { TOKEN: encOld },
        apiKey: null,
      },
    ]) as typeof currentDb;
    mcpAdapterMocks.connectMcp.mockReset();
    mcpAdapterMocks.connectMcp.mockResolvedValue(mockMcpConnection([{ name: 'do_thing' }]));

    const { updateMcpServerConfigAction } = await import('../src/lib/actions.ts');
    const r = await updateMcpServerConfigAction('aaaaaaaa-0000-0000-0000-0000000005b1', {
      name: 'FS renamed',
      command: 'npx',
      args: ['-y', 'new-pkg'],
      env: { TOKEN: '' }, // blank → keep stored value
    });
    expect(r.ok).toBe(true);

    // connect-and-verify ran with the NEW args and the DECRYPTED stored secret.
    const connectArg = mcpAdapterMocks.connectMcp.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(connectArg['command']).toBe('npx');
    expect(connectArg['args']).toEqual(['-y', 'new-pkg']);
    expect(connectArg['env']).toEqual({ TOKEN: 'stored-token' });

    // Persisted row: new args, name, tools refreshed; ciphertext UNCHANGED (kept).
    const set = setPayload();
    expect(set?.['name']).toBe('FS renamed');
    expect(set?.['args']).toEqual(['-y', 'new-pkg']);
    expect((set?.['envVars'] as Record<string, string>)['TOKEN']).toBe(encOld);
    expect(set?.['availableTools']).toEqual([{ name: 'do_thing', description: null }]);
  });

  it('stdio: a new env value REPLACES with a fresh ciphertext and verifies with the plaintext', async () => {
    currentDb = makeDb([
      {
        id: 'aaaaaaaa-0000-0000-0000-0000000005b2',
        name: 'FS',
        slug: 'fs',
        transport: 'stdio',
        command: 'npx',
        args: ['-y', 'pkg'],
        envVars: { TOKEN: encrypt('old') },
        apiKey: null,
      },
    ]) as typeof currentDb;
    mcpAdapterMocks.connectMcp.mockReset();
    mcpAdapterMocks.connectMcp.mockResolvedValue(mockMcpConnection([]));

    const { updateMcpServerConfigAction } = await import('../src/lib/actions.ts');
    const r = await updateMcpServerConfigAction('aaaaaaaa-0000-0000-0000-0000000005b2', {
      name: 'FS',
      command: 'npx',
      args: ['-y', 'pkg'],
      env: { TOKEN: 'brand-new' },
    });
    expect(r.ok).toBe(true);

    const connectArg = mcpAdapterMocks.connectMcp.mock.calls[0]?.[0] as Record<string, unknown>;
    expect((connectArg['env'] as Record<string, string>)['TOKEN']).toBe('brand-new');

    const stored = (setPayload()?.['envVars'] as Record<string, string>)['TOKEN']!;
    expect(isEncrypted(stored)).toBe(true);
    expect(stored).not.toBe('brand-new');
    expect(decrypt(stored)).toBe('brand-new');
  });

  it('http: blank apiKey KEEPS the stored key (set payload omits apiKey) and verifies with the decrypted key', async () => {
    const encKey = encrypt('sk_live_existing');
    currentDb = makeDb([
      {
        id: 'aaaaaaaa-0000-0000-0000-0000000005b3',
        name: 'API',
        slug: 'my-api',
        transport: 'http',
        url: 'https://old.example.com/mcp',
        authScheme: 'header',
        authParamName: 'x-api-key',
        command: null,
        args: null,
        envVars: {},
        apiKey: encKey,
        apiKeyLast4: 'ting',
      },
    ]) as typeof currentDb;
    mcpAdapterMocks.connectMcp.mockReset();
    mcpAdapterMocks.connectMcp.mockResolvedValue(mockMcpConnection([{ name: 'ping' }]));

    const { updateMcpServerConfigAction } = await import('../src/lib/actions.ts');
    const r = await updateMcpServerConfigAction('aaaaaaaa-0000-0000-0000-0000000005b3', {
      name: 'API v2',
      url: 'https://new.example.com/mcp',
      authScheme: 'header',
      authParamName: 'x-api-key',
      // apiKey omitted → keep
    });
    expect(r.ok).toBe(true);

    const connectArg = mcpAdapterMocks.connectMcp.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(connectArg['url']).toBe('https://new.example.com/mcp');
    expect(connectArg['apiKey']).toBe('sk_live_existing'); // decrypted stored key

    const set = setPayload();
    expect(set?.['url']).toBe('https://new.example.com/mcp');
    expect(set?.['name']).toBe('API v2');
    expect('apiKey' in (set ?? {})).toBe(false); // key untouched
  });

  it('fails loud and writes nothing when the new config cannot connect', async () => {
    currentDb = makeDb([
      {
        id: 'aaaaaaaa-0000-0000-0000-0000000005b4',
        name: 'FS',
        slug: 'fs',
        transport: 'stdio',
        command: 'npx',
        args: ['-y', 'pkg'],
        envVars: {},
        apiKey: null,
      },
    ]) as typeof currentDb;
    mcpAdapterMocks.connectMcp.mockReset();
    mcpAdapterMocks.connectMcp.mockRejectedValue(new Error('spawn failed'));

    const { updateMcpServerConfigAction } = await import('../src/lib/actions.ts');
    const r = await updateMcpServerConfigAction('aaaaaaaa-0000-0000-0000-0000000005b4', {
      name: 'FS',
      command: 'nope',
      args: [],
      env: {},
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('mcp_connect_failed');
    // No UPDATE was issued.
    const updateSpy = (currentDb as unknown as { update: ReturnType<typeof vi.fn> }).update;
    expect(updateSpy).not.toHaveBeenCalled();
  });
});

describe('deleteMcpServerAction', () => {
  it('rejects a non-uuid id', async () => {
    const { deleteMcpServerAction } = await import('../src/lib/actions.ts');
    const r = await deleteMcpServerAction('not-a-uuid');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('validation_failed');
  });

  it('returns not_found when the server does not belong to the entity', async () => {
    currentDb = makeDb([]) as typeof currentDb;
    const { deleteMcpServerAction } = await import('../src/lib/actions.ts');
    const r = await deleteMcpServerAction('aaaaaaaa-0000-0000-0000-0000000003b1');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('not_found');
  });
});

describe('setAgentMcpServerAssignmentAction', () => {
  it('returns not_found when the agent does not belong to the entity', async () => {
    currentDb = makeDb([]) as typeof currentDb;
    const { setAgentMcpServerAssignmentAction } = await import('../src/lib/actions.ts');
    const r = await setAgentMcpServerAssignmentAction(
      'aaaaaaaa-0000-0000-0000-0000000003c1',
      'aaaaaaaa-0000-0000-0000-0000000003c2',
      true,
      null,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('not_found');
  });

  it('assigned=true upserts an agent_mcp_servers row with the enabledTools whitelist', async () => {
    currentDb = makeDb([{ id: 'aaaaaaaa-0000-0000-0000-0000000003d1' }]) as typeof currentDb;
    const { setAgentMcpServerAssignmentAction } = await import('../src/lib/actions.ts');
    const r = await setAgentMcpServerAssignmentAction(
      'aaaaaaaa-0000-0000-0000-0000000003d1',
      'aaaaaaaa-0000-0000-0000-0000000003d2',
      true,
      ['get_home'],
    );
    expect(r.ok).toBe(true);
    const insertSpy = (currentDb as unknown as { insert: ReturnType<typeof vi.fn> }).insert;
    const valuesFn = (insertSpy.mock.results[0]?.value as { values?: ReturnType<typeof vi.fn> })
      .values;
    const values = valuesFn?.mock.calls[0]?.[0] as Record<string, unknown> | undefined;
    expect(values?.['enabledTools']).toEqual(['get_home']);
  });

  it('assigned=false deletes the assignment row', async () => {
    currentDb = makeDb([{ id: 'aaaaaaaa-0000-0000-0000-0000000003e1' }]) as typeof currentDb;
    const { setAgentMcpServerAssignmentAction } = await import('../src/lib/actions.ts');
    const r = await setAgentMcpServerAssignmentAction(
      'aaaaaaaa-0000-0000-0000-0000000003e1',
      'aaaaaaaa-0000-0000-0000-0000000003e2',
      false,
      null,
    );
    expect(r.ok).toBe(true);
    expect(
      (currentDb as unknown as { delete: ReturnType<typeof vi.fn> }).delete,
    ).toHaveBeenCalled();
  });
});

describe('listMcpServersAction', () => {
  it('returns empty instances and full catalog when entity has none connected', async () => {
    currentDb = makeDb([]) as typeof currentDb;
    const { listMcpServersAction } = await import('../src/lib/actions.ts');
    const r = await listMcpServersAction();
    expect(r.ok).toBe(true);
    if (r.ok) {
      // No instances when entity has no rows
      expect(r.data.instances.length).toBe(0);
      // Catalog always contains all entries
      const cogni = r.data.catalog.find((c) => c.slug === 'cogni-cortex');
      expect(cogni).toBeDefined();
      expect(cogni?.keyPrefix).toEqual(['cog_']);
    }
  });
});

// ─── LLM key actions (Brique 24) ─────────────────────────────────────────────
//
// Critical invariants enforced by these tests:
//   (1) listLlmKeysAction NEVER returns an `apiKey` field.
//   (2) testLlmKeyAction redacts the apiKey in any error message.
//
// Both are non-negotiable. Breaking either is a security regression.

describe('listLlmKeysAction', () => {
  it('returns rows WITHOUT an apiKey field and WITH apiKeyLast4 (security invariant #1)', async () => {
    currentDb = makeDb([
      {
        id: 'aaaaaaaa-0000-0000-0000-000000000010',
        provider: 'anthropic',
        baseUrl: null,
        nickname: 'My Anthropic',
        defaultModel: 'claude-haiku-4-5-20251001',
        isActive: true,
        hasApiKey: true,
        apiKeyLast4: 'K8sQ',
      },
    ]) as typeof currentDb;
    const { listLlmKeysAction } = await import('../src/lib/actions.ts');
    const r = await listLlmKeysAction();
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data).toHaveLength(1);
    const row = r.data[0]!;
    // CRITICAL: apiKey must NEVER be present, even as null/empty.
    expect(Object.keys(row)).not.toContain('apiKey');
    expect(row.hasApiKey).toBe(true);
    expect(row.nickname).toBe('My Anthropic');
    // apiKeyLast4 must be present for masked display in the edit form.
    expect(row.apiKeyLast4).toBe('K8sQ');
  });

  it('returns apiKeyLast4 as null when apiKey is empty', async () => {
    currentDb = makeDb([
      {
        id: 'aaaaaaaa-0000-0000-0000-000000000010',
        provider: 'ollama',
        baseUrl: 'http://localhost:11434',
        nickname: 'Local Ollama',
        defaultModel: 'llama3.3:70b',
        isActive: true,
        hasApiKey: false,
        apiKeyLast4: null,
      },
    ]) as typeof currentDb;
    const { listLlmKeysAction } = await import('../src/lib/actions.ts');
    const r = await listLlmKeysAction();
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const row = r.data[0]!;
    expect(Object.keys(row)).not.toContain('apiKey');
    expect(row.hasApiKey).toBe(false);
    expect(row.apiKeyLast4).toBeNull();
  });

  it('returns empty array on no rows', async () => {
    currentDb = makeDb([]) as typeof currentDb;
    const { listLlmKeysAction } = await import('../src/lib/actions.ts');
    const r = await listLlmKeysAction();
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data).toEqual([]);
  });
});

describe('createLlmKeyAction — validation', () => {
  it('rejects unknown provider', async () => {
    const { createLlmKeyAction } = await import('../src/lib/actions.ts');
    const r = await createLlmKeyAction({
      provider: 'made-up',
      nickname: 'X',
      defaultModel: 'm',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('validation_failed');
  });

  it('accepts a missing nickname (optional) and stores null', async () => {
    // select (dup check) returns [] → no existing provider; insert returns the id.
    currentDb = makeDbMixed({
      select: [],
      insert: [{ id: 'aaaaaaaa-0000-0000-0000-000000000012' }],
    }) as typeof currentDb;
    const { createLlmKeyAction } = await import('../src/lib/actions.ts');
    const r = await createLlmKeyAction({ provider: 'anthropic' });
    expect(r.ok).toBe(true);
    // Persisted as null — the UI falls back to the provider name for display.
    const insertSpy = (currentDb as unknown as { insert: ReturnType<typeof vi.fn> }).insert;
    const valuesArg = (insertSpy.mock.results[0]?.value as { values: ReturnType<typeof vi.fn> })
      ?.values?.mock?.calls?.[0]?.[0] as Record<string, unknown> | undefined;
    expect(valuesArg?.['nickname']).toBeNull();
  });

  it('rejects a provider that is already configured', async () => {
    // The dup-check select returns an existing row → provider_exists.
    currentDb = makeDb([{ id: 'aaaaaaaa-0000-0000-0000-000000000099' }]) as typeof currentDb;
    const { createLlmKeyAction } = await import('../src/lib/actions.ts');
    const r = await createLlmKeyAction({ provider: 'anthropic', apiKey: 'sk-x' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('provider_exists');
  });

  it('rejects malformed baseUrl', async () => {
    const { createLlmKeyAction } = await import('../src/lib/actions.ts');
    const r = await createLlmKeyAction({
      provider: 'anthropic',
      baseUrl: 'not a url',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('validation_failed');
  });
});

describe('createLlmKeyAction — db path', () => {
  it('returns ok with id on successful insert (apiKey encrypted at rest, last4 plaintext)', async () => {
    currentDb = makeDbMixed({
      select: [],
      insert: [{ id: 'aaaaaaaa-0000-0000-0000-000000000011' }],
    }) as typeof currentDb;
    const { createLlmKeyAction } = await import('../src/lib/actions.ts');
    const r = await createLlmKeyAction({
      provider: 'anthropic',
      apiKey: 'sk-ant-secret-1',
      nickname: 'Anthropic main',
      isActive: true,
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data.id).toBe('aaaaaaaa-0000-0000-0000-000000000011');
    const insertSpy = (currentDb as unknown as { insert: ReturnType<typeof vi.fn> }).insert;
    const valuesArg = (insertSpy.mock.results[0]?.value as { values: ReturnType<typeof vi.fn> })
      ?.values?.mock?.calls?.[0]?.[0] as Record<string, unknown> | undefined;
    // Brique 26: apiKey is stored as ciphertext (not plaintext) and round-trips.
    const stored = valuesArg?.['apiKey'] as string;
    expect(typeof stored).toBe('string');
    expect(stored).not.toBe('sk-ant-secret-1');
    expect(isEncrypted(stored)).toBe(true);
    expect(decrypt(stored)).toBe('sk-ant-secret-1');
    // last4 is stored plaintext for masked display in the list.
    expect(valuesArg?.['apiKeyLast4']).toBe('et-1');
    expect(valuesArg?.['provider']).toBe('anthropic');
  });

  it('apiKey defaults to empty string when not provided (no encryption applied)', async () => {
    currentDb = makeDbMixed({
      select: [],
      insert: [{ id: 'aaaaaaaa-0000-0000-0000-000000000012' }],
    }) as typeof currentDb;
    const { createLlmKeyAction } = await import('../src/lib/actions.ts');
    const r = await createLlmKeyAction({
      provider: 'ollama',
      baseUrl: 'http://localhost:11434',
      nickname: 'Local Ollama',
    });
    expect(r.ok).toBe(true);
    const insertSpy = (currentDb as unknown as { insert: ReturnType<typeof vi.fn> }).insert;
    const valuesArg = (insertSpy.mock.results[0]?.value as { values: ReturnType<typeof vi.fn> })
      ?.values?.mock?.calls?.[0]?.[0] as Record<string, unknown> | undefined;
    expect(valuesArg?.['apiKey']).toBe('');
    expect(valuesArg?.['apiKeyLast4']).toBe('');
  });
});

describe('setLlmKeyActiveAction', () => {
  it('flips is_active on an owned key', async () => {
    currentDb = makeDb([{ id: 'aaaaaaaa-0000-0000-0000-000000000031' }]) as typeof currentDb;
    const { setLlmKeyActiveAction } = await import('../src/lib/actions.ts');
    const r = await setLlmKeyActiveAction('aaaaaaaa-0000-0000-0000-000000000031', false);
    expect(r.ok).toBe(true);
    const updateSpy = (currentDb as unknown as { update: ReturnType<typeof vi.fn> }).update;
    const setArg = (updateSpy.mock.results[0]?.value as { set: ReturnType<typeof vi.fn> })?.set
      ?.mock?.calls?.[0]?.[0] as Record<string, unknown> | undefined;
    expect(setArg?.['isActive']).toBe(false);
  });

  it('rejects a bad uuid', async () => {
    const { setLlmKeyActiveAction } = await import('../src/lib/actions.ts');
    const r = await setLlmKeyActiveAction('not-uuid', true);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('validation_failed');
  });
});

describe('updateLlmKeyAction', () => {
  it('rejects bad uuid', async () => {
    const { updateLlmKeyAction } = await import('../src/lib/actions.ts');
    const r = await updateLlmKeyAction({
      id: 'not-a-uuid',
      provider: 'anthropic',
      nickname: 'X',
      defaultModel: 'm',
      isActive: true,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('validation_failed');
  });

  it('returns not_found when row is in another entity', async () => {
    // Empty rows from the ownership check → not_found
    currentDb = makeDb([]) as typeof currentDb;
    const { updateLlmKeyAction } = await import('../src/lib/actions.ts');
    const r = await updateLlmKeyAction({
      id: 'aaaaaaaa-0000-0000-0000-000000000020',
      provider: 'anthropic',
      nickname: 'X',
      defaultModel: 'm',
      isActive: true,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('not_found');
  });

  it('updates apiKey when a new value is provided (encrypted ciphertext + last4)', async () => {
    currentDb = makeDb([{ id: 'aaaaaaaa-0000-0000-0000-000000000020' }]) as typeof currentDb;
    const { updateLlmKeyAction } = await import('../src/lib/actions.ts');
    const r = await updateLlmKeyAction({
      id: 'aaaaaaaa-0000-0000-0000-000000000020',
      provider: 'anthropic',
      apiKey: 'sk-ant-rotated',
      nickname: 'Rotated',
      defaultModel: 'claude-haiku-4-5',
      isActive: true,
    });
    expect(r.ok).toBe(true);
    const updateSpy = (currentDb as unknown as { update: ReturnType<typeof vi.fn> }).update;
    const setArg = (updateSpy.mock.results[0]?.value as { set: ReturnType<typeof vi.fn> })?.set
      ?.mock?.calls?.[0]?.[0] as Record<string, unknown> | undefined;
    // Brique 26: rotation stores ciphertext (not plaintext) and updates last4.
    const stored = setArg?.['apiKey'] as string;
    expect(typeof stored).toBe('string');
    expect(stored).not.toBe('sk-ant-rotated');
    expect(isEncrypted(stored)).toBe(true);
    expect(decrypt(stored)).toBe('sk-ant-rotated');
    expect(setArg?.['apiKeyLast4']).toBe('ated');
  });

  it('keeps existing apiKey AND apiKeyLast4 when new apiKey is omitted', async () => {
    currentDb = makeDb([{ id: 'aaaaaaaa-0000-0000-0000-000000000020' }]) as typeof currentDb;
    const { updateLlmKeyAction } = await import('../src/lib/actions.ts');
    const r = await updateLlmKeyAction({
      id: 'aaaaaaaa-0000-0000-0000-000000000020',
      provider: 'anthropic',
      nickname: 'Renamed',
      defaultModel: 'claude-haiku-4-5',
      isActive: true,
    });
    expect(r.ok).toBe(true);
    const updateSpy = (currentDb as unknown as { update: ReturnType<typeof vi.fn> }).update;
    const setArg = (updateSpy.mock.results[0]?.value as { set: ReturnType<typeof vi.fn> })?.set
      ?.mock?.calls?.[0]?.[0] as Record<string, unknown> | undefined;
    // Brique 26: omitting apiKey must leave BOTH apiKey AND apiKeyLast4 untouched.
    expect(setArg?.['apiKey']).toBeUndefined();
    expect(setArg?.['apiKeyLast4']).toBeUndefined();
  });
});

describe('deleteLlmKeyAction', () => {
  it('rejects non-uuid id', async () => {
    const { deleteLlmKeyAction } = await import('../src/lib/actions.ts');
    const r = await deleteLlmKeyAction('not-uuid');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('validation_failed');
  });

  it('returns not_found when id is in another entity', async () => {
    currentDb = makeDb([]) as typeof currentDb;
    const { deleteLlmKeyAction } = await import('../src/lib/actions.ts');
    const r = await deleteLlmKeyAction('aaaaaaaa-0000-0000-0000-000000000030');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('not_found');
  });

  it('happy path: delete is called', async () => {
    currentDb = makeDb([{ id: 'aaaaaaaa-0000-0000-0000-000000000030' }]) as typeof currentDb;
    const { deleteLlmKeyAction } = await import('../src/lib/actions.ts');
    const r = await deleteLlmKeyAction('aaaaaaaa-0000-0000-0000-000000000030');
    expect(r.ok).toBe(true);
    const deleteSpy = (currentDb as unknown as { delete: ReturnType<typeof vi.fn> }).delete;
    expect(deleteSpy).toHaveBeenCalled();
  });
});

describe('testLlmKeyAction', () => {
  it('rejects unknown provider', async () => {
    const { testLlmKeyAction } = await import('../src/lib/actions.ts');
    const r = await testLlmKeyAction({ provider: 'made-up' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('validation_failed');
  });

  it('returns ok with model count on 200 response', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: () => Promise.resolve(''),
      json: () =>
        Promise.resolve({
          data: [{ id: 'claude-haiku-4-5' }, { id: 'claude-sonnet-4-6' }],
        }),
    });
    vi.stubGlobal('fetch', fetchMock);
    try {
      const { testLlmKeyAction } = await import('../src/lib/actions.ts');
      const r = await testLlmKeyAction({
        provider: 'anthropic',
        apiKey: 'sk-ant-secret-test',
      });
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.data.message).toContain('2');
      // Sanity: the request used the x-api-key header, not the URL
      const callArgs = fetchMock.mock.calls[0];
      expect(callArgs?.[0]).toBe('https://api.anthropic.com/v1/models');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('SECURITY: apiKey is REDACTED in error messages (security invariant #2)', async () => {
    const SECRET = 'sk-ant-this-is-a-real-secret-do-not-leak';
    // First-line defense: mock fetch to throw with the apiKey embedded in the
    // error message. The action MUST scrub it before returning.
    const fetchMock = vi
      .fn()
      .mockRejectedValue(new Error(`Connection failed for ${SECRET} (network unreachable)`));
    vi.stubGlobal('fetch', fetchMock);
    try {
      const { testLlmKeyAction } = await import('../src/lib/actions.ts');
      const r = await testLlmKeyAction({
        provider: 'anthropic',
        apiKey: SECRET,
      });
      expect(r.ok).toBe(false);
      if (r.ok) return;
      // CRITICAL: the apiKey must NEVER appear in the message.
      expect(r.message).not.toContain(SECRET);
      expect(r.message).toContain('[REDACTED]');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('SECURITY (F-1, audit #2): the remote response body is never reflected on non-2xx, apiKey included', async () => {
    const SECRET = 'sk-leaked-in-body-do-not-echo';
    // Provider echoes back the key in its 401 response (some do). The action
    // must never forward that body to the UI at all — not even redacted —
    // since a body reached via a malicious/misconfigured baseUrl could
    // contain anything (F-1 hardens against reflecting internal responses).
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      text: () => Promise.resolve(`Invalid key: ${SECRET}`),
    });
    vi.stubGlobal('fetch', fetchMock);
    try {
      const { testLlmKeyAction } = await import('../src/lib/actions.ts');
      const r = await testLlmKeyAction({
        provider: 'openai',
        apiKey: SECRET,
      });
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.message).not.toContain(SECRET);
      expect(r.message).not.toContain('Invalid key');
      expect(r.message).toContain('401');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('ollama: builds request from baseUrl with no apiKey header', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: () => Promise.resolve(''),
      json: () => Promise.resolve({ models: [{ name: 'llama3.3' }] }),
    });
    vi.stubGlobal('fetch', fetchMock);
    try {
      const { testLlmKeyAction } = await import('../src/lib/actions.ts');
      const r = await testLlmKeyAction({
        provider: 'ollama',
        baseUrl: 'http://localhost:11434',
      });
      expect(r.ok).toBe(true);
      const url = fetchMock.mock.calls[0]?.[0];
      expect(url).toBe('http://localhost:11434/api/tags');
      const headers = (fetchMock.mock.calls[0]?.[1] as { headers: Record<string, string> }).headers;
      expect(headers['Authorization']).toBeUndefined();
      expect(headers['x-api-key']).toBeUndefined();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('openai-compatible without baseUrl returns validation_failed', async () => {
    const { testLlmKeyAction } = await import('../src/lib/actions.ts');
    const r = await testLlmKeyAction({ provider: 'openai-compatible' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('validation_failed');
  });

  it('keyId provided + apiKey empty → decrypts saved key + uses correct Authorization header', async () => {
    const SAVED_KEY = 'sk-ant-saved-from-db';
    // Brique 26: the column stores ciphertext; the action must decrypt it.
    const { encrypt } = await import('@nodal-agents/secrets');
    currentDb = makeDb([{ apiKey: encrypt(SAVED_KEY) }]) as typeof currentDb;
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: () => Promise.resolve(''),
      json: () => Promise.resolve({ data: [{ id: 'claude-haiku-4-5' }] }),
    });
    vi.stubGlobal('fetch', fetchMock);
    try {
      const { testLlmKeyAction } = await import('../src/lib/actions.ts');
      const r = await testLlmKeyAction({
        provider: 'anthropic',
        keyId: 'aaaaaaaa-0000-0000-0000-000000000099',
        // No apiKey — simulates edit mode without re-typing
      });
      expect(r.ok).toBe(true);
      // The fetch must have used the saved key in the x-api-key header
      const reqHeaders = (fetchMock.mock.calls[0]?.[1] as { headers: Record<string, string> })
        .headers;
      expect(reqHeaders['x-api-key']).toBe(SAVED_KEY);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('keyId from a different entity → returns not_found', async () => {
    // DB returns empty rows (ownership check fails — different entity)
    currentDb = makeDb([]) as typeof currentDb;
    const { testLlmKeyAction } = await import('../src/lib/actions.ts');
    const r = await testLlmKeyAction({
      provider: 'openai',
      keyId: 'aaaaaaaa-0000-0000-0000-000000000088',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('not_found');
  });

  it('both apiKey and keyId missing → proceeds without auth (no_api_key_provided or connection error)', async () => {
    // Without a keyId, the server has no way to look up a saved key.
    // The request proceeds with no auth header and the upstream responds with an error.
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      text: () => Promise.resolve('Unauthorized'),
    });
    vi.stubGlobal('fetch', fetchMock);
    try {
      const { testLlmKeyAction } = await import('../src/lib/actions.ts');
      const r = await testLlmKeyAction({ provider: 'anthropic' });
      // Must fail — no key, no keyId means no credentials
      expect(r.ok).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('openrouter uses /auth/key (auth-required) not /models (public)', async () => {
    // OpenRouter's /v1/models is a public endpoint that returns 200 even
    // without a key — using it as the test endpoint produces false positives.
    // /auth/key requires a valid Bearer token and 401s on bad keys.
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: () => Promise.resolve(''),
      json: () => Promise.resolve({ data: { label: 'main', usage: 0 } }),
    });
    vi.stubGlobal('fetch', fetchMock);
    try {
      const { testLlmKeyAction } = await import('../src/lib/actions.ts');
      const r = await testLlmKeyAction({
        provider: 'openrouter',
        apiKey: 'sk-or-v1-test',
      });
      expect(r.ok).toBe(true);
      const url = fetchMock.mock.calls[0]?.[0];
      expect(url).toBe('https://openrouter.ai/api/v1/auth/key');
      expect(url).not.toContain('/models');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('openrouter returns connection_failed when /auth/key responds 401', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      text: () => Promise.resolve('{"error":"invalid_api_key"}'),
    });
    vi.stubGlobal('fetch', fetchMock);
    try {
      const { testLlmKeyAction } = await import('../src/lib/actions.ts');
      const r = await testLlmKeyAction({
        provider: 'openrouter',
        apiKey: 'sk-or-v1-bogus',
      });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe('connection_failed');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('cloud provider honors user-provided baseUrl override (e.g., proxy)', async () => {
    // Brique 24+ regression: testLlmKeyAction must use the user's baseUrl
    // when set, not silently fall back to the canonical URL. Use case: an
    // enterprise proxy in front of Anthropic, alternate region, or mock.
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: () => Promise.resolve(''),
      json: () => Promise.resolve({ data: [] }),
    });
    vi.stubGlobal('fetch', fetchMock);
    try {
      const { testLlmKeyAction } = await import('../src/lib/actions.ts');
      const r = await testLlmKeyAction({
        provider: 'anthropic',
        baseUrl: 'https://my-proxy.corp/anthropic-v1',
        apiKey: 'sk-ant-test',
      });
      expect(r.ok).toBe(true);
      const url = fetchMock.mock.calls[0]?.[0];
      expect(url).toBe('https://my-proxy.corp/anthropic-v1/models');
      expect(url).not.toContain('api.anthropic.com');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

// ─── setAgentConnectorAssignmentAction ───────────────────────────────────────

describe('setAgentConnectorAssignmentAction — validation', () => {
  it('rejects non-uuid agentId', async () => {
    const { setAgentConnectorAssignmentAction } = await import('../src/lib/actions.ts');
    const r = await setAgentConnectorAssignmentAction(
      'not-uuid',
      'aaaaaaaa-0000-0000-0000-000000000001',
      true,
      null,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('validation_failed');
  });

  it('rejects non-uuid connectorId', async () => {
    const { setAgentConnectorAssignmentAction } = await import('../src/lib/actions.ts');
    const r = await setAgentConnectorAssignmentAction(
      'aaaaaaaa-0000-0000-0000-000000000001',
      'not-uuid',
      true,
      null,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('validation_failed');
  });
});

describe('setAgentConnectorAssignmentAction — db path', () => {
  it('assigned=true with null ops: returns ok (UPSERT all-enabled)', async () => {
    // DB returns agent row on first select, connector row on second
    const agentId = 'aaaaaaaa-0000-0000-0000-000000000001';
    const connectorId = 'bbbbbbbb-0000-0000-0000-000000000001';
    currentDb = makeDb([{ id: agentId }]) as typeof currentDb;
    const { setAgentConnectorAssignmentAction } = await import('../src/lib/actions.ts');
    const r = await setAgentConnectorAssignmentAction(agentId, connectorId, true, null);
    expect(r.ok).toBe(true);

    // insert must have been called (upsert path)
    const insertSpy = (currentDb as unknown as { insert: ReturnType<typeof vi.fn> }).insert;
    expect(insertSpy).toHaveBeenCalled();
  });

  it('assigned=true with partial ops: UPSERT stores only listed slugs', async () => {
    const agentId = 'aaaaaaaa-0000-0000-0000-000000000002';
    const connectorId = 'bbbbbbbb-0000-0000-0000-000000000002';
    const enabledOps = ['drive_list_files', 'drive_read_file'];
    currentDb = makeDb([{ id: agentId }]) as typeof currentDb;
    const { setAgentConnectorAssignmentAction } = await import('../src/lib/actions.ts');
    const r = await setAgentConnectorAssignmentAction(agentId, connectorId, true, enabledOps);
    expect(r.ok).toBe(true);

    const insertSpy = (currentDb as unknown as { insert: ReturnType<typeof vi.fn> }).insert;
    const valuesCalls = insertSpy.mock.results
      .flatMap((res) => (res.value as { values?: ReturnType<typeof vi.fn> }).values?.mock?.calls)
      .filter(Boolean) as unknown[][];

    const insertedRow = valuesCalls[0]?.[0] as Record<string, unknown> | undefined;
    expect(insertedRow?.['enabledOperations']).toEqual(enabledOps);
  });

  it('assigned=false: idempotent delete — returns ok even if row absent', async () => {
    const agentId = 'aaaaaaaa-0000-0000-0000-000000000003';
    const connectorId = 'bbbbbbbb-0000-0000-0000-000000000003';
    currentDb = makeDb([{ id: agentId }]) as typeof currentDb;
    const { setAgentConnectorAssignmentAction } = await import('../src/lib/actions.ts');
    const r = await setAgentConnectorAssignmentAction(agentId, connectorId, false, null);
    expect(r.ok).toBe(true);

    // delete must have been called
    const deleteSpy = (currentDb as unknown as { delete: ReturnType<typeof vi.fn> }).delete;
    expect(deleteSpy).toHaveBeenCalled();
  });

  it('forbidden cross-entity: returns not_found when agent does not belong to session entity', async () => {
    const agentId = 'aaaaaaaa-0000-0000-0000-000000000004';
    const connectorId = 'bbbbbbbb-0000-0000-0000-000000000004';
    // DB returns empty array — agent not found for this entity
    currentDb = makeDb([]) as typeof currentDb;
    const { setAgentConnectorAssignmentAction } = await import('../src/lib/actions.ts');
    const r = await setAgentConnectorAssignmentAction(agentId, connectorId, true, null);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('not_found');
  });
});

// ─── listAgentConnectorsAction ────────────────────────────────────────────────

describe('listAgentConnectorsAction — validation', () => {
  it('rejects non-uuid agentId', async () => {
    const { listAgentConnectorsAction } = await import('../src/lib/actions.ts');
    const r = await listAgentConnectorsAction('not-uuid');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('validation_failed');
  });
});

describe('listAgentConnectorsAction — db path', () => {
  it('returns not_found when agent does not belong to session entity', async () => {
    currentDb = makeDb([]) as typeof currentDb;
    const { listAgentConnectorsAction } = await import('../src/lib/actions.ts');
    const r = await listAgentConnectorsAction('aaaaaaaa-0000-0000-0000-000000000001');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('not_found');
  });

  it('returns ok with empty array when no connectors exist', async () => {
    // First select() returns agent row, second select() returns [] (no connectors)
    // The chain mock returns the same rows for every call — so we need agent row.
    // The action returns ok([]) early when connectorRows.length === 0.
    // But since our chain mock always returns the same rows, we make it return an
    // agent-shaped row, then the action will proceed to query connectors and get
    // the same row (wrong shape but length > 0). To test the empty case, we rely
    // on the fact that a connector row without a slug matching ADAPTER_REGISTRY
    // will be filtered out.
    const agentId = 'aaaaaaaa-0000-0000-0000-000000000005';
    // Use a synthetic slug that no adapter package will ever claim — the
    // intent of this test is to prove the "no adapter for this slug → drop
    // it" branch, not to pin a specific catalog entry. (Brique 34quinquies
    // shipped concrete adapters for every real catalog slug.)
    const fakeSlug = 'unregistered-test-slug';
    currentDb = makeDb([
      { id: agentId, slug: fakeSlug, name: 'Fake', credentialId: null, active: true },
    ]) as typeof currentDb;
    const { listAgentConnectorsAction } = await import('../src/lib/actions.ts');
    const r = await listAgentConnectorsAction(agentId);
    expect(r.ok).toBe(true);
    if (r.ok) {
      // unregistered slug has no ADAPTER_REGISTRY entry — filtered out
      const entries = r.data.filter((c) => c.slug === fakeSlug);
      expect(entries).toHaveLength(0);
    }
  });

  it('exposes availableOperations from ADAPTER_REGISTRY for adapter-backed connectors', async () => {
    const agentId = 'aaaaaaaa-0000-0000-0000-000000000006';
    const connectorId = 'cccccccc-0000-0000-0000-000000000001';
    // Return a connector with a slug that IS in ADAPTER_REGISTRY
    currentDb = makeDb([
      {
        id: connectorId,
        slug: 'google-drive',
        name: 'My Drive',
        credentialId: null,
        active: true,
        agentId,
      },
    ]) as typeof currentDb;
    const { listAgentConnectorsAction } = await import('../src/lib/actions.ts');
    const r = await listAgentConnectorsAction(agentId);
    expect(r.ok).toBe(true);
    if (r.ok) {
      const driveEntry = r.data.find((c) => c.slug === 'google-drive');
      expect(driveEntry).toBeDefined();
      expect(Array.isArray(driveEntry?.availableOperations)).toBe(true);
      expect(driveEntry!.availableOperations.length).toBeGreaterThan(0);
      // Every availableOperation must have required fields
      for (const op of driveEntry!.availableOperations) {
        expect(typeof op.slug).toBe('string');
        expect(['read', 'write', 'destructive']).toContain(op.risk);
      }
    }
  });
});
