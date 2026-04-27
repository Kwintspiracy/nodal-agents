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

  it('returns ok when job row exists', async () => {
    currentDb = makeDb([
      {
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
        createdAt: new Date(),
        completedAt: null,
      },
    ]) as typeof currentDb;
    const { getJobDetailAction } = await import('../src/lib/actions.ts');
    const r = await getJobDetailAction('cccccccc-0000-0000-0000-000000000001');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data.id).toBe('cccccccc-0000-0000-0000-000000000001');
  });
});
