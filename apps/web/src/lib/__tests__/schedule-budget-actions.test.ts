// schedule-budget-actions.test.ts — unit tests for the dailyBudgetUsd field on
// createScheduleAction / updateScheduleAction (Event Triggers, Brique 3).
// Asserts on real DB state (not call counts — CLAUDE.md invariant 5).

import { describe, it, expect, beforeAll, vi } from 'vitest';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import { eq, agentSchedules } from '@nodal-agents/db';

let testDb: TestDb;
let seed: Awaited<ReturnType<typeof seedMinimal>>;

vi.mock('@/lib/server.ts', () => ({
  getDb: () => testDb,
  getAuthProvider: () => ({ name: 'local-trust' }),
  applyActiveEntity: (session: { userId: string; entityId?: string }) => ({
    ...session,
    entityId: seed?.entityId ?? session.entityId ?? '',
  }),
}));

vi.mock('next/headers', () => ({
  headers: async () => new Headers(),
  cookies: async () => ({
    set: () => {},
    get: () => null,
    delete: () => {},
  }),
}));

vi.mock('next/cache', () => ({
  revalidatePath: () => {},
}));

vi.mock('@nodal-agents/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@nodal-agents/auth')>();
  return {
    ...actual,
    requireAuth: async () => ({
      userId: 'mock-user-id',
      entityId: seed?.entityId ?? 'mock-entity-id',
    }),
  };
});

beforeAll(async () => {
  const result = await spinUpTestDb();
  testDb = result.db;
  seed = await seedMinimal(testDb);
});

describe('createScheduleAction — dailyBudgetUsd', () => {
  it('defaults to 5 when omitted', async () => {
    const { createScheduleAction } = await import('../actions.ts');
    const result = await createScheduleAction({
      agentId: seed.agentId,
      name: 'web-default-budget',
      cronExpr: '0 9 * * *',
      task: 'do the thing',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');

    const [row] = await testDb
      .select({ dailyBudgetUsd: agentSchedules.dailyBudgetUsd })
      .from(agentSchedules)
      .where(eq(agentSchedules.id, result.data.id));
    expect(row?.dailyBudgetUsd).toBe(5);
  });

  it('persists an explicit value', async () => {
    const { createScheduleAction } = await import('../actions.ts');
    const result = await createScheduleAction({
      agentId: seed.agentId,
      name: 'web-custom-budget',
      cronExpr: '0 9 * * *',
      task: 'do the thing',
      dailyBudgetUsd: 20,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');

    const [row] = await testDb
      .select({ dailyBudgetUsd: agentSchedules.dailyBudgetUsd })
      .from(agentSchedules)
      .where(eq(agentSchedules.id, result.data.id));
    expect(row?.dailyBudgetUsd).toBe(20);
  });

  it('rejects a value outside 0.5-100', async () => {
    const { createScheduleAction } = await import('../actions.ts');
    const result = await createScheduleAction({
      agentId: seed.agentId,
      name: 'web-invalid-budget',
      cronExpr: '0 9 * * *',
      task: 'do the thing',
      dailyBudgetUsd: 0.1,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected fail');
    expect(result.code).toBe('validation_failed');
  });
});

describe('updateScheduleAction — dailyBudgetUsd', () => {
  it('updates the ceiling on an existing schedule', async () => {
    const { createScheduleAction, updateScheduleAction } = await import('../actions.ts');
    const created = await createScheduleAction({
      agentId: seed.agentId,
      name: 'web-update-budget',
      cronExpr: '0 9 * * *',
      task: 'do the thing',
    });
    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error('expected ok');

    const updated = await updateScheduleAction({
      id: created.data.id,
      agentId: seed.agentId,
      name: 'web-update-budget',
      cronExpr: '0 9 * * *',
      task: 'do the thing',
      dailyBudgetUsd: 42,
    });
    expect(updated.ok).toBe(true);

    const [row] = await testDb
      .select({ dailyBudgetUsd: agentSchedules.dailyBudgetUsd })
      .from(agentSchedules)
      .where(eq(agentSchedules.id, created.data.id));
    expect(row?.dailyBudgetUsd).toBe(42);
  });

  it('rejects a value outside 0.5-100', async () => {
    const { createScheduleAction, updateScheduleAction } = await import('../actions.ts');
    const created = await createScheduleAction({
      agentId: seed.agentId,
      name: 'web-update-invalid-budget',
      cronExpr: '0 9 * * *',
      task: 'do the thing',
    });
    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error('expected ok');

    const updated = await updateScheduleAction({
      id: created.data.id,
      agentId: seed.agentId,
      name: 'web-update-invalid-budget',
      cronExpr: '0 9 * * *',
      task: 'do the thing',
      dailyBudgetUsd: 500,
    });
    expect(updated.ok).toBe(false);
    if (updated.ok) throw new Error('expected fail');
    expect(updated.code).toBe('validation_failed');
  });
});
