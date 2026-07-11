// meta-ops/schedule-ops.test.ts — unit tests for the create_schedule /
// update_schedule tools' dailyBudgetUsd field (Event Triggers, Brique 3).
// Uses a real pglite in-memory DB via @nodal-agents/db/test-utils.
// Asserts on the real agent_schedules row — never call counts.

import { describe, it, expect, beforeAll } from 'vitest';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import { agentSchedules, agents, eq } from '@nodal-agents/db';
import type { ToolContext } from '../../types';
import { createScheduleTool, updateScheduleTool } from './schedule-ops';

let db: TestDb;
let seed: { userId: string; entityId: string; agentId: string; jobId: string };
let agentName: string;

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

describe('create_schedule — dailyBudgetUsd', () => {
  it('defaults to 5 when omitted', async () => {
    const result = await createScheduleTool.execute(
      { agentSlug: agentName, name: 'default-budget', atTimes: ['09:00'], task: 'do the thing' },
      makeCtx(),
    );
    expect(result.ok).toBe(true);

    const [row] = await db
      .select({ dailyBudgetUsd: agentSchedules.dailyBudgetUsd })
      .from(agentSchedules)
      .where(eq(agentSchedules.name, 'default-budget'));
    expect(row?.dailyBudgetUsd).toBe(5);
  });

  it('persists an explicit value', async () => {
    const result = await createScheduleTool.execute(
      {
        agentSlug: agentName,
        name: 'custom-budget',
        atTimes: ['09:00'],
        task: 'do the thing',
        dailyBudgetUsd: 12.5,
      },
      makeCtx(),
    );
    expect(result.ok).toBe(true);

    const [row] = await db
      .select({ dailyBudgetUsd: agentSchedules.dailyBudgetUsd })
      .from(agentSchedules)
      .where(eq(agentSchedules.name, 'custom-budget'));
    expect(row?.dailyBudgetUsd).toBe(12.5);
  });

  it('rejects a value outside 0.5-100 (Zod bounds)', () => {
    const tooLow = createScheduleTool.inputSchema.safeParse({
      agentSlug: agentName,
      name: 'x',
      atTimes: ['09:00'],
      task: 't',
      dailyBudgetUsd: 0.4,
    });
    expect(tooLow.success).toBe(false);

    const tooHigh = createScheduleTool.inputSchema.safeParse({
      agentSlug: agentName,
      name: 'x',
      atTimes: ['09:00'],
      task: 't',
      dailyBudgetUsd: 100.1,
    });
    expect(tooHigh.success).toBe(false);

    const inBounds = createScheduleTool.inputSchema.safeParse({
      agentSlug: agentName,
      name: 'x',
      atTimes: ['09:00'],
      task: 't',
      dailyBudgetUsd: 50,
    });
    expect(inBounds.success).toBe(true);
  });
});

describe('update_schedule — dailyBudgetUsd', () => {
  it('updates the ceiling on an existing schedule', async () => {
    await createScheduleTool.execute(
      { agentSlug: agentName, name: 'update-budget', atTimes: ['09:00'], task: 'do the thing' },
      makeCtx(),
    );

    const result = await updateScheduleTool.execute(
      { name: 'update-budget', dailyBudgetUsd: 30 },
      makeCtx(),
    );
    expect(result.ok).toBe(true);

    const [row] = await db
      .select({ dailyBudgetUsd: agentSchedules.dailyBudgetUsd })
      .from(agentSchedules)
      .where(eq(agentSchedules.name, 'update-budget'));
    expect(row?.dailyBudgetUsd).toBe(30);
  });

  it('rejects a value outside 0.5-100 (Zod bounds)', () => {
    const tooLow = updateScheduleTool.inputSchema.safeParse({
      name: 'update-budget',
      dailyBudgetUsd: 0.1,
    });
    expect(tooLow.success).toBe(false);

    const tooHigh = updateScheduleTool.inputSchema.safeParse({
      name: 'update-budget',
      dailyBudgetUsd: 250,
    });
    expect(tooHigh.success).toBe(false);
  });

  it('returns ok:false with nothing to update when dailyBudgetUsd is the only omitted field', async () => {
    const result = await updateScheduleTool.execute({ name: 'update-budget' }, makeCtx());
    expect(result.ok).toBe(false);
  });
});
