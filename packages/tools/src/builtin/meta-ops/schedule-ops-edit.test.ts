// meta-ops/schedule-ops-edit.test.ts — update_schedule changes what it names and
// keeps everything else, on the REAL stored row (pglite), whatever the way the
// schedule was created: an agent's create_schedule, a row the dashboard wrote, a
// cron expression typed by hand. The expected rows come from the table the
// dashboard's action test reads too: one change, one stored row, through every
// writer.

import { describe, it, expect, beforeAll } from 'vitest';
import { CronExpressionParser } from 'cron-parser';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import { agentSchedules, agents, entities, eq } from '@nodal-agents/db';
import { BASE_SCHEDULE, SCHEDULE_CHANGE_CASES } from '@nodal-agents/shared/schedule-change-cases';
import type { ScheduleChangeCase } from '@nodal-agents/shared/schedule-change-cases';
import type { ToolContext } from '../../types';
import { createScheduleTool, updateScheduleTool } from './schedule-ops';

let db: TestDb;
let seed: { userId: string; entityId: string; agentId: string; jobId: string };
let agentName: string;

const SENTINEL_NEXT_RUN = new Date('2030-01-01T00:00:00Z');

beforeAll(async () => {
  const res = await spinUpTestDb();
  db = res.db;
  seed = await seedMinimal(db);
  const [agent] = await db
    .select({ name: agents.name })
    .from(agents)
    .where(eq(agents.id, seed.agentId));
  agentName = agent!.name;
});

function makeCtx(): ToolContext {
  return {
    jobId: seed.jobId,
    agentId: seed.agentId,
    entityId: seed.entityId,
    db: db as unknown as ToolContext['db'],
    jobChatId: null,
  };
}

async function readRow(name: string) {
  const [row] = await db.select().from(agentSchedules).where(eq(agentSchedules.name, name));
  if (!row) throw new Error(`no schedule named ${name}`);
  return row;
}

/** The agent's vocabulary for a change of the shared table. */
function toolInput(name: string, change: ScheduleChangeCase['change']) {
  return {
    name,
    ...(change.atTimes !== undefined ? { atTimes: change.atTimes } : {}),
    ...(change.everyMinutes !== undefined ? { everyMinutes: change.everyMinutes } : {}),
    ...(change.days !== undefined ? { days: change.days } : {}),
    ...(change.task !== undefined ? { task: change.task } : {}),
    ...(change.name !== undefined ? { newName: change.name } : {}),
    ...(change.notifyOnSuccess !== undefined ? { notifyOnSuccess: change.notifyOnSuccess } : {}),
    ...(change.dailyBudgetUsd !== undefined ? { dailyBudgetUsd: change.dailyBudgetUsd } : {}),
  };
}

async function insertStored(name: string, stored: ScheduleChangeCase['stored']) {
  await db.insert(agentSchedules).values({
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
  });
}

describe('update_schedule keeps what it does not name @cap:planifier-une-tache/moteur', () => {
  const toolCases = SCHEDULE_CHANGE_CASES.filter((c) => !c.toolCannotName);

  it.each(toolCases.map((c, i) => [c.title, c, i] as const))('%s', async (_title, c, i) => {
    const name = `Edit case ${i}`;
    await insertStored(name, c.stored);
    const before = await readRow(name);
    const asked = new Date();

    const result = await updateScheduleTool.execute(toolInput(name, c.change), makeCtx());

    if ('error' in c.expect) {
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('expected a refusal');
      expect(result.error).toMatch(c.expect.error);
      // Refused: the stored row is exactly what it was.
      expect(await readRow(name)).toEqual(before);
      return;
    }

    if (!result.ok) throw new Error(result.error);
    const after = await readRow(c.expect.set.name ?? name);
    const expected = { ...before, ...c.expect.set };
    // Every column the change does not name is the stored one (cron, zone, agent,
    // instruction, notification, budget, active, last run…); updatedAt and the
    // next run are the two the write moves.
    const { updatedAt: _u1, nextRun, ...afterFields } = after;
    const { updatedAt: _u2, nextRun: _n, ...expectedFields } = expected;
    expect(afterFields).toEqual(expectedFields);

    const namesTiming =
      c.change.atTimes !== undefined ||
      c.change.everyMinutes !== undefined ||
      c.change.days !== undefined;
    if (namesTiming) {
      // The next run is the first fire of the NEW cron in the schedule's own zone.
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
  });
});

describe('the result states the schedule as it is now @cap:planifier-une-tache/moteur', () => {
  it('days, times, zone, cron, notification, budget and the next runs', async () => {
    await insertStored('Result weekdays', { cronExpr: '0 9 * * 1-5', timezone: 'Europe/Paris' });
    const result = await updateScheduleTool.execute(
      { name: 'Result weekdays', atTimes: ['10:00'] },
      makeCtx(),
    );
    if (!result.ok) throw new Error(result.error);
    expect(result.message).toContain('Updated schedule "Result weekdays" (changed: cronExpr)');
    expect(result.message).toContain('at 10:00, weekdays (Mon-Fri) (Europe/Paris)');
    expect(result.message).toContain('cron "0 10 * * 1-5"');
    expect(result.message).toContain('success notification on, daily budget $7.5');
    const row = await readRow('Result weekdays');
    expect(result.message).toContain(`Next runs: ${row.nextRun!.toISOString()}`);
  });

  it('a refusal says what the schedule is and what can still be changed on it', async () => {
    await insertStored('Result hand cron', {
      cronExpr: '*/10 9-17 * * 1-5',
      timezone: 'Europe/Paris',
    });
    const result = await updateScheduleTool.execute(
      { name: 'Result hand cron', atTimes: ['10:00'] },
      makeCtx(),
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected a refusal');
    expect(result.error).toContain('cron "*/10 9-17 * * 1-5"');
    expect(result.error).toContain('weekdays (Mon-Fri)');
    expect(result.error).toContain('not changed');
    expect(result.error).toContain(
      'You can change its days, its task, name, notification and budget',
    );
  });
});

describe('any way of creating the schedule @cap:planifier-une-tache/moteur', () => {
  it('created by the agent tool, then moved: the days and the zone it was created with stay', async () => {
    await db
      .update(entities)
      .set({ timezone: 'Europe/Paris' })
      .where(eq(entities.id, seed.entityId));
    const created = await createScheduleTool.execute(
      {
        agentSlug: agentName,
        name: 'Made by the tool',
        atTimes: ['09:00'],
        days: 'weekdays',
        task: 'Post it',
      },
      makeCtx(),
    );
    expect(created.ok).toBe(true);
    expect((await readRow('Made by the tool')).cronExpr).toBe('0 9 * * 1-5');

    // The workspace zone changes afterwards: the schedule keeps the zone its hours were written in.
    await db.update(entities).set({ timezone: 'Asia/Tokyo' }).where(eq(entities.id, seed.entityId));
    try {
      const moved = await updateScheduleTool.execute(
        { name: 'Made by the tool', atTimes: ['10:00'] },
        makeCtx(),
      );
      expect(moved.ok).toBe(true);
      const row = await readRow('Made by the tool');
      expect(row.cronExpr).toBe('0 10 * * 1-5');
      expect(row.timezone).toBe('Europe/Paris');
      const first = CronExpressionParser.parse('0 10 * * 1-5', {
        currentDate: new Date(),
        tz: 'Europe/Paris',
      })
        .next()
        .toDate();
      expect(row.nextRun!.getTime()).toBe(first.getTime());
    } finally {
      await db.update(entities).set({ timezone: null }).where(eq(entities.id, seed.entityId));
    }
  });

  it('created by the agent tool as an interval, then given days: the interval stays', async () => {
    await createScheduleTool.execute(
      { agentSlug: agentName, name: 'Interval made by the tool', everyMinutes: 30, task: 'Poll' },
      makeCtx(),
    );
    const moved = await updateScheduleTool.execute(
      { name: 'Interval made by the tool', days: 'weekdays' },
      makeCtx(),
    );
    expect(moved.ok).toBe(true);
    expect((await readRow('Interval made by the tool')).cronExpr).toBe('*/30 * * * 1-5');
  });

  it('a schedule the dashboard wrote with no zone (legacy) keeps no zone, and the result names the server zone', async () => {
    await insertStored('Dashboard legacy', { cronExpr: '0 9 * * 1-5', timezone: null });
    const moved = await updateScheduleTool.execute(
      { name: 'Dashboard legacy', atTimes: ['10:00'] },
      makeCtx(),
    );
    if (!moved.ok) throw new Error(moved.error);
    const row = await readRow('Dashboard legacy');
    expect(row.timezone).toBeNull();
    expect(row.cronExpr).toBe('0 10 * * 1-5');
  });

  it('naming nothing changes nothing and says so', async () => {
    await insertStored('Named nothing', { cronExpr: '0 9 * * 1-5', timezone: 'Europe/Paris' });
    const before = await readRow('Named nothing');
    const result = await updateScheduleTool.execute({ name: 'Named nothing' }, makeCtx());
    expect(result.ok).toBe(false);
    expect(await readRow('Named nothing')).toEqual(before);
  });

  it('an empty time list is refused instead of being ignored', async () => {
    await insertStored('Empty times', { cronExpr: '0 9 * * 1-5', timezone: 'Europe/Paris' });
    const before = await readRow('Empty times');
    const result = await updateScheduleTool.execute(
      { name: 'Empty times', atTimes: [], task: 'Other' },
      makeCtx(),
    );
    expect(result.ok).toBe(false);
    expect(await readRow('Empty times')).toEqual(before);
  });
});
