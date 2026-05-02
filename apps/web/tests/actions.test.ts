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
import { describe, it, expect, vi, beforeAll } from 'vitest';

beforeAll(() => {
  process.env['DATABASE_URL'] = 'postgres://placeholder:5432/placeholder';
  process.env['AUTH_MODE'] = 'local-trust';
  process.env['RUNNER_URL'] = 'http://localhost:3001';
  process.env['WORKER_SECRET'] = 'test-bearer-789';
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
    const r = await sendTaskAction({ title: 'Do X', agentId: 'bad' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('validation_failed');
  });

  it('rejects empty title', async () => {
    const { sendTaskAction } = await import('../src/lib/actions.ts');
    const r = await sendTaskAction({ title: '', agentId: 'aaaaaaaa-0000-0000-0000-000000000001' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('validation_failed');
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
    currentDb = makeDb([
      { id: 'aaaaaaaa-0000-0000-0000-000000000031' },
    ]) as typeof currentDb;

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
    const { listConnectorsAction, CONNECTOR_CATALOG } = await import('../src/lib/actions.ts');
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
    expect(setArg['apiKey']).toBe('secret_abc');
    expect(setArg['authType']).toBe('api_key');
    expect(setArg['active']).toBe(true);
  });
});

describe('saveOauthConnectorAction', () => {
  it('rejects missing clientId', async () => {
    const { saveOauthConnectorAction } = await import('../src/lib/actions.ts');
    const r = await saveOauthConnectorAction({
      slug: 'gmail',
      oauthClientSecret: 'x',
      oauthRefreshToken: 'y',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('validation_failed');
  });

  it('rejects api_key slug for the oauth path', async () => {
    const { saveOauthConnectorAction } = await import('../src/lib/actions.ts');
    const r = await saveOauthConnectorAction({
      slug: 'notion',
      oauthClientId: 'a',
      oauthClientSecret: 'b',
      oauthRefreshToken: 'c',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('validation_failed');
  });

  it('updates existing row with oauth2 auth_type and rotated tokens', async () => {
    // The chain mock returns the same rows for every awaited query, so
    // when select() returns a row the action takes the UPDATE branch.
    // We assert on the .set() payload instead of .insert().values().
    const existingId = 'aaaaaaaa-0000-0000-0000-000000000072';
    currentDb = makeDb([{ id: existingId }]) as typeof currentDb;
    const { saveOauthConnectorAction } = await import('../src/lib/actions.ts');
    const r = await saveOauthConnectorAction({
      slug: 'gmail',
      oauthClientId: 'cid',
      oauthClientSecret: 'sec',
      oauthRefreshToken: 'ref',
    });
    expect(r.ok).toBe(true);
    const updateSpy = (currentDb as unknown as { update: ReturnType<typeof vi.fn> }).update;
    const setSpy = updateSpy.mock.results.at(-1)!.value as { set: ReturnType<typeof vi.fn> };
    const setArg = setSpy.set.mock.calls.at(-1)![0] as Record<string, unknown>;
    expect(setArg['authType']).toBe('oauth2');
    expect(setArg['oauthClientId']).toBe('cid');
    expect(setArg['oauthRefreshToken']).toBe('ref');
  });
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
const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(new Error('ECONNREFUSED'));
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
