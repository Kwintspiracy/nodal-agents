// cron/tests/unblock-ready.test.ts
// Acceptance criteria:
//   - task with all deps done → context.deps injected
//   - task with some deps still todo → NOT updated
//   - task with no deps → NOT touched by unblockReadyTasks (already ready)
//   - dep results injected as { depId: result } map in context.deps
//   - second call is idempotent (only updates if status='todo')

import { describe, it, expect, beforeAll } from 'vitest';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import { eq } from '@nodal-agents/db';
import { agentTasks } from '@nodal-agents/db';
import { unblockReadyTasks } from '../unblock-ready.ts';

let db: TestDb;
let seed: Awaited<ReturnType<typeof seedMinimal>>;

beforeAll(async () => {
  const result = await spinUpTestDb();
  db = result.db;
  seed = await seedMinimal(db);
});

async function createTask(overrides: {
  status?: string;
  dependsOn?: string[];
  result?: string;
  context?: Record<string, unknown>;
}) {
  const rows = await db
    .insert(agentTasks)
    .values({
      entityId: seed.entityId,
      orchestratorId: seed.agentId,
      assignedAgentId: seed.agentId,
      title: 'Unblock test task',
      status: overrides.status ?? 'todo',
      dependsOn: (overrides.dependsOn ?? []) as unknown as string[],
      result: overrides.result ?? null,
      context: overrides.context ?? {},
    })
    .returning();
  return rows[0]!;
}

describe('unblockReadyTasks', () => {
  it('injects dep results when all deps are done', async () => {
    // Create two done dep tasks
    const dep1 = await createTask({ status: 'done', result: 'Result from dep 1' });
    const dep2 = await createTask({ status: 'done', result: 'Result from dep 2' });

    // Create the blocked task depending on both
    const task = await createTask({
      status: 'todo',
      dependsOn: [dep1.id, dep2.id],
    });

    const count = await unblockReadyTasks(db);
    expect(count).toBeGreaterThanOrEqual(1);

    // Verify context was injected
    const updated = await db
      .select({ context: agentTasks.context })
      .from(agentTasks)
      .where(eq(agentTasks.id, task.id));

    const ctx = updated[0]?.context as Record<string, unknown> | undefined;
    expect(ctx).toBeDefined();
    const deps = ctx?.['deps'] as Record<string, string> | undefined;
    expect(deps).toBeDefined();
    expect(deps?.[dep1.id]).toBe('Result from dep 1');
    expect(deps?.[dep2.id]).toBe('Result from dep 2');
  });

  it('does NOT unblock task when some deps are still todo', async () => {
    const doneDep = await createTask({ status: 'done', result: 'done result' });
    const todoDep = await createTask({ status: 'todo' });

    const task = await createTask({
      status: 'todo',
      dependsOn: [doneDep.id, todoDep.id],
    });

    await unblockReadyTasks(db);

    const updated = await db
      .select({ context: agentTasks.context })
      .from(agentTasks)
      .where(eq(agentTasks.id, task.id));

    // Context should not have deps key since not all deps are done
    const ctx = updated[0]?.context as Record<string, unknown> | undefined;
    expect(ctx?.['deps']).toBeUndefined();
  });

  it('does not touch tasks with no deps', async () => {
    const task = await createTask({ status: 'todo', dependsOn: [] });

    const beforeCtx = (
      await db
        .select({ context: agentTasks.context })
        .from(agentTasks)
        .where(eq(agentTasks.id, task.id))
    )[0]?.context;

    await unblockReadyTasks(db);

    const after = await db
      .select({ context: agentTasks.context })
      .from(agentTasks)
      .where(eq(agentTasks.id, task.id));

    expect(after[0]?.context).toEqual(beforeCtx);
  });

  it('is idempotent — second call does not corrupt context', async () => {
    const dep = await createTask({ status: 'done', result: 'idempotent dep result' });
    const task = await createTask({ status: 'todo', dependsOn: [dep.id] });

    await unblockReadyTasks(db);
    await unblockReadyTasks(db); // second call

    const updated = await db
      .select({ context: agentTasks.context })
      .from(agentTasks)
      .where(eq(agentTasks.id, task.id));

    const ctx = updated[0]?.context as Record<string, unknown> | undefined;
    const deps = ctx?.['deps'] as Record<string, string> | undefined;
    expect(deps?.[dep.id]).toBe('idempotent dep result');
  });

  it('merges deps into existing context without losing other keys', async () => {
    const dep = await createTask({ status: 'done', result: 'dep result' });
    const task = await createTask({
      status: 'todo',
      dependsOn: [dep.id],
      context: { existing_key: 'existing_value' },
    });

    await unblockReadyTasks(db);

    const updated = await db
      .select({ context: agentTasks.context })
      .from(agentTasks)
      .where(eq(agentTasks.id, task.id));

    const ctx = updated[0]?.context as Record<string, unknown> | undefined;
    expect(ctx?.['existing_key']).toBe('existing_value');
    const deps = ctx?.['deps'] as Record<string, string> | undefined;
    expect(deps?.[dep.id]).toBe('dep result');
  });

  it('returns count of tasks unblocked', async () => {
    const dep = await createTask({ status: 'done', result: 'r' });
    await createTask({ status: 'todo', dependsOn: [dep.id] });
    await createTask({ status: 'todo', dependsOn: [dep.id] });

    const count = await unblockReadyTasks(db);
    expect(count).toBeGreaterThanOrEqual(2);
  });
});

describe('unblockReadyTasks — D4: a deleted dependency terminalizes the task', () => {
  it('blocks a todo task whose dependency row no longer exists', async () => {
    // A dep id that was validated at create time but has since been
    // cascade-deleted (its agent/entity removed) — the row is simply gone.
    const missingDepId = '00000000-0000-0000-0000-0000000000d4';
    const task = await createTask({ status: 'todo', dependsOn: [missingDepId] });

    const count = await unblockReadyTasks(db);
    expect(count).toBeGreaterThanOrEqual(1);

    // The task is terminalized (blocked) — NOT left in 'todo' forever, which
    // would keep the root job non-terminal and stall delivery.
    const [row] = await db
      .select({ status: agentTasks.status, result: agentTasks.result })
      .from(agentTasks)
      .where(eq(agentTasks.id, task.id));
    expect(row?.status).toBe('blocked');
    expect(row?.result ?? '').toMatch(/removed/i);
  });
});
