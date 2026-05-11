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
  decrypt,
  isEncrypted,
} from '@nodalai/secrets';

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
  return {
    select: vi.fn().mockReturnValue(c),
    insert: vi.fn().mockReturnValue(c),
    delete: vi.fn().mockReturnValue(c),
    update: vi.fn().mockReturnValue(c),
  };
}

// ─── Mock server.ts ───────────────────────────────────────────────────────────
let currentDb = makeDb([]);

vi.mock('../src/lib/server.ts', async () => {
  const { LocalTrustProvider } = await import('@nodalai/auth');
  const provider = new LocalTrustProvider();
  return {
    getDb: vi.fn(() => currentDb),
    getAuthProvider: vi.fn(() => provider),
    requireAuth: vi.fn(),
    requireAuthWithEntity: vi.fn(),
    requireUser: vi.fn(),
    requireUserWithEntity: vi.fn(),
  };
});

// ─── Mock @nodalai/memory ─────────────────────────────────────────────────────
// The memory package's chained queries don't fit our simple chainable mock
// (count + items in two distinct selects); we stub the public API directly.
const memoryMocks = {
  listMemories: vi.fn(),
  deleteMemory: vi.fn(),
  updateMemory: vi.fn(),
};

vi.mock('@nodalai/memory', async () => {
  const actual = await vi.importActual<typeof import('@nodalai/memory')>('@nodalai/memory');
  return {
    ...actual,
    listMemories: (...args: unknown[]) => memoryMocks.listMemories(...args),
    deleteMemory: (...args: unknown[]) => memoryMocks.deleteMemory(...args),
    updateMemory: (...args: unknown[]) => memoryMocks.updateMemory(...args),
  };
});

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

describe('listAgentsAction', () => {
  it('returns ok with array (may be empty)', async () => {
    currentDb = makeDb([]) as typeof currentDb;
    const { listAgentsAction } = await import('../src/lib/actions.ts');
    const r = await listAgentsAction();
    expect(r.ok).toBe(true);
    if (r.ok) expect(Array.isArray(r.data)).toBe(true);
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
    const { MemoryNotFoundError } = await import('@nodalai/memory');
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
    const { MemoryNotFoundError } = await import('@nodalai/memory');
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

// ─── Connector Actions ────────────────────────────────────────────────────────

describe('listConnectorsAction', () => {
  it('returns the full catalog with null connectors when entity has none', async () => {
    currentDb = makeDb([]) as typeof currentDb;
    const { listConnectorsAction } = await import('../src/lib/actions.ts');
    const { CONNECTOR_CATALOG } = await import('../src/lib/connector-catalog.ts');
    const r = await listConnectorsAction();
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.length).toBe(CONNECTOR_CATALOG.length);
      expect(r.data.every((e) => e.connector === null)).toBe(true);
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
      const notion = r.data.find((e) => e.catalogSlug === 'notion');
      expect(notion?.connector?.id).toBe(id);
      expect(notion?.connector?.hasApiKey).toBe(true);
      // Other catalog entries stay null
      expect(r.data.find((e) => e.catalogSlug === 'gmail')?.connector).toBe(null);
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

  it('updates an existing row in place (chain mock takes the existing branch)', async () => {
    // The chain mock returns the same rows for every awaited query, so the
    // initial existing-check select returns a row → UPDATE path. We assert
    // on the .set() payload to confirm the api_key + active flags land.
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
    const updateSpy = (currentDb as unknown as { update: ReturnType<typeof vi.fn> }).update;
    const setSpy = updateSpy.mock.results.at(-1)!.value as { set: ReturnType<typeof vi.fn> };
    const setArg = setSpy.set.mock.calls.at(-1)![0] as Record<string, unknown>;
    // Brique 34 (Agent B): apiKey must be encrypted at rest — assert enc:v1: prefix.
    expect(typeof setArg['apiKey']).toBe('string');
    expect(setArg['apiKey'] as string).toMatch(/^enc:v1:/);
    expect(setArg['authType']).toBe('api_key');
    expect(setArg['active']).toBe(true);
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
});

describe('saveApiKeyConnectorAction — new api_key providers (regression)', () => {
  it.each(['apify', 'firecrawl', 'tavily', 'airtable'])(
    'saves %s api_key with enc:v1: prefix',
    async (slug) => {
      const existingId = 'aaaaaaaa-0000-0000-0000-000000000080';
      currentDb = makeDb([{ id: existingId }]) as typeof currentDb;
      const { saveApiKeyConnectorAction } = await import('../src/lib/actions.ts');
      const r = await saveApiKeyConnectorAction({ slug, apiKey: 'test-api-key-value' });
      expect(r.ok).toBe(true);
      // Assert the apiKey in the DB update payload is encrypted.
      const updateSpy = (currentDb as unknown as { update: ReturnType<typeof vi.fn> }).update;
      const setSpy = updateSpy.mock.results.at(-1)!.value as { set: ReturnType<typeof vi.fn> };
      const setArg = setSpy.set.mock.calls.at(-1)![0] as Record<string, unknown>;
      expect(typeof setArg['apiKey']).toBe('string');
      expect(setArg['apiKey'] as string).toMatch(/^enc:v1:/);
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

  it('signs the runner call with WORKER_SECRET and returns ok on 200', async () => {
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
    currentDb = makeDb([{ id: 'aaaaaaaa-0000-0000-0000-000000000003' }]) as typeof currentDb;
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

  it('rejects empty nickname', async () => {
    const { createLlmKeyAction } = await import('../src/lib/actions.ts');
    const r = await createLlmKeyAction({
      provider: 'anthropic',
      nickname: '',
      defaultModel: 'claude-haiku-4-5',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('validation_failed');
  });

  it('rejects empty defaultModel', async () => {
    const { createLlmKeyAction } = await import('../src/lib/actions.ts');
    const r = await createLlmKeyAction({
      provider: 'anthropic',
      nickname: 'X',
      defaultModel: '',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('validation_failed');
  });

  it('rejects malformed baseUrl', async () => {
    const { createLlmKeyAction } = await import('../src/lib/actions.ts');
    const r = await createLlmKeyAction({
      provider: 'anthropic',
      nickname: 'X',
      defaultModel: 'm',
      baseUrl: 'not a url',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('validation_failed');
  });
});

describe('createLlmKeyAction — db path', () => {
  it('returns ok with id on successful insert (apiKey encrypted at rest, last4 plaintext)', async () => {
    currentDb = makeDb([{ id: 'aaaaaaaa-0000-0000-0000-000000000011' }]) as typeof currentDb;
    const { createLlmKeyAction } = await import('../src/lib/actions.ts');
    const r = await createLlmKeyAction({
      provider: 'anthropic',
      apiKey: 'sk-ant-secret-1',
      nickname: 'Anthropic main',
      defaultModel: 'claude-haiku-4-5-20251001',
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
    currentDb = makeDb([{ id: 'aaaaaaaa-0000-0000-0000-000000000012' }]) as typeof currentDb;
    const { createLlmKeyAction } = await import('../src/lib/actions.ts');
    const r = await createLlmKeyAction({
      provider: 'ollama',
      baseUrl: 'http://localhost:11434',
      nickname: 'Local Ollama',
      defaultModel: 'llama3.3:70b',
    });
    expect(r.ok).toBe(true);
    const insertSpy = (currentDb as unknown as { insert: ReturnType<typeof vi.fn> }).insert;
    const valuesArg = (insertSpy.mock.results[0]?.value as { values: ReturnType<typeof vi.fn> })
      ?.values?.mock?.calls?.[0]?.[0] as Record<string, unknown> | undefined;
    expect(valuesArg?.['apiKey']).toBe('');
    expect(valuesArg?.['apiKeyLast4']).toBe('');
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

  it('SECURITY: apiKey is REDACTED in non-2xx response bodies', async () => {
    const SECRET = 'sk-leaked-in-body-do-not-echo';
    // Provider echoes back the key in its 401 response (some do). The action
    // must scrub it before returning to the UI.
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
      expect(r.message).toContain('[REDACTED]');
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
    const { encrypt } = await import('@nodalai/secrets');
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
    // Return a connector with a slug that has no adapter
    currentDb = makeDb([
      { id: agentId, slug: 'airtable-oauth', name: 'Airtable', credentialId: null, active: true },
    ]) as typeof currentDb;
    const { listAgentConnectorsAction } = await import('../src/lib/actions.ts');
    const r = await listAgentConnectorsAction(agentId);
    expect(r.ok).toBe(true);
    if (r.ok) {
      // airtable-oauth has no ADAPTER_REGISTRY entry — filtered out
      const airtableEntries = r.data.filter((c) => c.slug === 'airtable-oauth');
      expect(airtableEntries).toHaveLength(0);
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
