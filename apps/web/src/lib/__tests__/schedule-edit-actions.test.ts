// schedule-edit-actions.test.ts — the dashboard's edit of a schedule names what it
// changes and keeps everything else, on the REAL stored row (pglite). The
// expected rows come from the same table the agent's update_schedule test reads:
// one change, one stored row, through either writer.

import { describe, it, expect, beforeAll, vi } from 'vitest';
import { CronExpressionParser } from 'cron-parser';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import { eq, agentSchedules } from '@nodal-agents/db';
import { BASE_SCHEDULE, SCHEDULE_CHANGE_CASES } from '@nodal-agents/shared/schedule-change-cases';
import type { ScheduleChangeCase } from '@nodal-agents/shared/schedule-change-cases';

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

const SENTINEL_NEXT_RUN = new Date('2030-01-01T00:00:00Z');

async function insertStored(
  name: string,
  stored: ScheduleChangeCase['stored'],
  extra: Partial<typeof agentSchedules.$inferInsert> = {},
): Promise<string> {
  const [row] = await testDb
    .insert(agentSchedules)
    .values({
      entityId: seed.entityId,
      agentId: seed.agentId,
      type: 'cron',
      name,
      cronExpr: stored.cronExpr,
      timezone: stored.timezone,
      task: BASE_SCHEDULE.task,
      notifyOnSuccess: BASE_SCHEDULE.notifyOnSuccess,
      notifyChannel: BASE_SCHEDULE.notifyChannel,
      dailyBudgetUsd: BASE_SCHEDULE.dailyBudgetUsd,
      active: true,
      nextRun: SENTINEL_NEXT_RUN,
      ...extra,
    })
    .returning({ id: agentSchedules.id });
  return row!.id;
}

async function readRow(id: string) {
  const [row] = await testDb.select().from(agentSchedules).where(eq(agentSchedules.id, id));
  if (!row) throw new Error(`no schedule ${id}`);
  return row;
}

describe('updateScheduleAction keeps what it does not name @cap:planifier-une-tache/moteur', () => {
  it.each(SCHEDULE_CHANGE_CASES.map((c, i) => [c.title, c, i] as const))(
    '%s',
    async (_title, c, i) => {
      const { updateScheduleAction } = await import('../actions.ts');
      const id = await insertStored(`Edit case ${i}`, c.stored);
      const before = await readRow(id);
      const asked = new Date();

      const result = await updateScheduleAction({ id, ...c.change });

      if ('error' in c.expect) {
        expect(result.ok).toBe(false);
        if (result.ok) throw new Error('expected a refusal');
        expect(result.code).toBe('validation_failed');
        expect(result.message).toMatch(c.expect.error);
        expect(await readRow(id)).toEqual(before);
        return;
      }

      if (!result.ok) throw new Error(result.message);
      const after = await readRow(id);
      const expected = { ...before, ...c.expect.set };
      const { updatedAt: _u1, nextRun, ...afterFields } = after;
      const { updatedAt: _u2, nextRun: _n, ...expectedFields } = expected;
      expect(afterFields).toEqual(expectedFields);

      const namesTiming =
        c.change.atTimes !== undefined ||
        c.change.everyMinutes !== undefined ||
        c.change.days !== undefined ||
        c.change.timezone !== undefined;
      if (namesTiming) {
        const first = CronExpressionParser.parse(after.cronExpr, {
          currentDate: asked,
          ...(after.timezone ? { tz: after.timezone } : {}),
        })
          .next()
          .toDate();
        expect(nextRun?.getTime()).toBe(first.getTime());
      } else {
        expect(nextRun?.getTime()).toBe(SENTINEL_NEXT_RUN.getTime());
      }
    },
  );
});

describe('the dashboard form (the whole expression, every field) @cap:planifier-une-tache/moteur', () => {
  it('saving a hand-written cron untouched keeps it byte for byte, and the zone', async () => {
    const { updateScheduleAction } = await import('../actions.ts');
    const id = await insertStored('Form hand cron', {
      cronExpr: '*/10 9-17 * * 1-5',
      timezone: 'Europe/Paris',
    });
    const result = await updateScheduleAction({
      id,
      agentId: seed.agentId,
      name: 'Form hand cron',
      cronExpr: '*/10 9-17 * * 1-5',
      task: 'A new instruction',
      notifyOnSuccess: true,
      notifyChannel: null,
      dailyBudgetUsd: 7.5,
    });
    expect(result.ok).toBe(true);
    const row = await readRow(id);
    expect(row.cronExpr).toBe('*/10 9-17 * * 1-5');
    expect(row.timezone).toBe('Europe/Paris');
    expect(row.task).toBe('A new instruction');
    // The next run is computed in the schedule's own zone, not the server's.
    const first = CronExpressionParser.parse('*/10 9-17 * * 1-5', {
      currentDate: new Date(),
      tz: 'Europe/Paris',
    })
      .next()
      .toDate();
    expect(Math.abs(row.nextRun!.getTime() - first.getTime())).toBeLessThanOrEqual(10 * 60_000);
  });

  it('a new expression from the form replaces the timing and keeps the other fields', async () => {
    const { updateScheduleAction } = await import('../actions.ts');
    const id = await insertStored('Form new cron', {
      cronExpr: '0 9 * * 1-5',
      timezone: 'Europe/Paris',
    });
    const result = await updateScheduleAction({ id, cronExpr: '0 10 1 * *' });
    expect(result.ok).toBe(true);
    const row = await readRow(id);
    expect(row.cronExpr).toBe('0 10 1 * *');
    expect(row.timezone).toBe('Europe/Paris');
    expect(row.task).toBe(BASE_SCHEDULE.task);
    expect(row.notifyOnSuccess).toBe(true);
    expect(row.dailyBudgetUsd).toBe(7.5);
  });

  it('a field left out is kept, never reset to a default (notification, channel, budget)', async () => {
    const { updateScheduleAction } = await import('../actions.ts');
    const id = await insertStored(
      'Form kept fields',
      { cronExpr: '0 9 * * 1-5', timezone: 'Europe/Paris' },
      { notifyChannel: 'slack' },
    );
    const result = await updateScheduleAction({ id, task: 'Only the instruction changes' });
    expect(result.ok).toBe(true);
    const row = await readRow(id);
    expect(row.task).toBe('Only the instruction changes');
    expect(row.notifyOnSuccess).toBe(true);
    expect(row.notifyChannel).toBe('slack');
    expect(row.dailyBudgetUsd).toBe(7.5);
    expect(row.cronExpr).toBe('0 9 * * 1-5');
  });

  it('an invalid expression is refused and nothing is written', async () => {
    const { updateScheduleAction } = await import('../actions.ts');
    const id = await insertStored('Form invalid cron', {
      cronExpr: '0 9 * * 1-5',
      timezone: 'Europe/Paris',
    });
    const before = await readRow(id);
    const result = await updateScheduleAction({ id, cronExpr: 'every morning' });
    expect(result.ok).toBe(false);
    expect(await readRow(id)).toEqual(before);
  });

  it('a schedule of another workspace is not found', async () => {
    const { updateScheduleAction } = await import('../actions.ts');
    const result = await updateScheduleAction({
      id: '00000000-0000-4000-8000-000000000999',
      task: 'x',
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected a refusal');
    expect(result.code).toBe('not_found');
  });
});
