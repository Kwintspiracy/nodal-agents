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

// P0-S1 (2026-07-22 incident): the sibling create_connector bug (repeat
// calls inserting duplicate rows blindly) applies equally to create_schedule
// — schedule name is the natural unique key within an entity. Repeat calls
// must fail loud instead of creating competing duplicate schedules.
describe('create_schedule — idempotence', () => {
  it('a fresh name succeeds and inserts exactly one row', async () => {
    const result = await createScheduleTool.execute(
      { agentSlug: agentName, name: 'idempotence-fresh', atTimes: ['09:00'], task: 'do the thing' },
      makeCtx(),
    );
    expect(result.ok).toBe(true);

    const rows = await db
      .select()
      .from(agentSchedules)
      .where(eq(agentSchedules.name, 'idempotence-fresh'));
    expect(rows).toHaveLength(1);
  });

  it('a repeat call with the same name fails loud and writes no second row', async () => {
    const first = await createScheduleTool.execute(
      { agentSlug: agentName, name: 'idempotence-repeat', atTimes: ['09:00'], task: 'first task' },
      makeCtx(),
    );
    expect(first.ok).toBe(true);

    const second = await createScheduleTool.execute(
      {
        agentSlug: agentName,
        name: 'idempotence-repeat',
        atTimes: ['10:00'],
        task: 'second task',
      },
      makeCtx(),
    );
    expect(second.ok).toBe(false);
    if (second.ok) throw new Error('expected failure');
    expect(second.error).toContain('already exists');

    const rows = await db
      .select()
      .from(agentSchedules)
      .where(eq(agentSchedules.name, 'idempotence-repeat'));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.task).toBe('first task');
  });
});

// H1b: routine/schedule lint — non-blocking warning surfaced in the success
// message when the routine references a tool the target agent doesn't have,
// or an ambiguous "state" phrase. Asserts on the real message string.
describe('create_schedule — routine lint (H1b)', () => {
  function makeCtxWithTools(availableTools: Set<string>): ToolContext {
    return {
      ...makeCtx(),
      resolveAgentToolNames: async () => availableTools,
    };
  }

  it('appends a lint warning when the task references an unavailable tool', async () => {
    const result = await createScheduleTool.execute(
      {
        agentSlug: agentName,
        name: 'lint-unavailable-tool',
        atTimes: ['09:00'],
        task: 'Call `cogni_cortex__get_state` to fetch the last snapshot.',
      },
      makeCtxWithTools(new Set(['query_memory', 'save_memory', 'return_result'])),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected success');
    expect(result.message).toContain('Routine lint');
    expect(result.message).toContain('cogni_cortex__get_state');
  });

  it('appends a lint warning for the "your state" phrasing (root incident)', async () => {
    const result = await createScheduleTool.execute(
      {
        agentSlug: agentName,
        name: 'lint-state-phrase',
        atTimes: ['09:00'],
        task: 'Retrieve the previously stored version from your state.',
      },
      makeCtxWithTools(new Set(['query_memory', 'save_memory', 'return_result'])),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected success');
    expect(result.message).toContain('Routine lint');
    expect(result.message.toLowerCase()).toContain('state');
  });

  it('returns success with NO lint warning for a clean routine', async () => {
    const result = await createScheduleTool.execute(
      {
        agentSlug: agentName,
        name: 'lint-clean',
        atTimes: ['09:00'],
        task: 'Use `query_memory` for context, then `save_memory` and `return_result`.',
      },
      makeCtxWithTools(new Set(['query_memory', 'save_memory', 'return_result'])),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected success');
    expect(result.message).not.toContain('Routine lint');
  });

  it('returns success with no warning when resolveAgentToolNames is absent (lightweight ctx)', async () => {
    const result = await createScheduleTool.execute(
      {
        agentSlug: agentName,
        name: 'lint-no-capability',
        atTimes: ['09:00'],
        task: 'Call `cogni_cortex__get_state` to fetch the last snapshot.',
      },
      makeCtx(), // no resolveAgentToolNames — lint must silently skip, never block
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected success');
    expect(result.message).not.toContain('Routine lint');
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
