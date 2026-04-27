// planner/dependencies.test.ts — validateDependencies and cycle detection

import { describe, it, expect, beforeAll } from 'vitest';
import { spinUpTestDb } from '@nodalai/db/test-utils';
import { agents, agentTasks } from '@nodalai/db';
import { validateDependencies, checkAllDepsResolved } from '../../planner/dependencies.js';
import { OrchestrationError } from '../../errors.js';
import type { TaskId } from '../../types.js';
import type { TestDb } from '@nodalai/db/test-utils';

let db: TestDb;

beforeAll(async () => {
  const res = await spinUpTestDb();
  db = res.db;
});

// ─── Seed helpers ──────────────────────────────────────────────────────────────

async function seedContext(db: TestDb) {
  const [user] = await db
    .insert((await import('@nodalai/db')).users)
    .values({ email: `test-dep-${Date.now()}@ex.com` })
    .returning();
  const [entity] = await db
    .insert((await import('@nodalai/db')).entities)
    .values({ userId: user!.id, name: 'T', slug: `e-dep-${Date.now()}` })
    .returning();
  const [agent] = await db
    .insert(agents)
    .values({
      entityId: entity!.id,
      name: 'Dep Agent',
      slug: `test-dep-agent-${Date.now()}`,
      personality: 'p',
      role: 'orchestrator',
    })
    .returning();
  return { entityId: entity!.id, agentId: agent!.id };
}

async function createTask(
  db: TestDb,
  entityId: string,
  agentId: string,
  title: string,
  status = 'todo',
  dependsOn: string[] = [],
) {
  const [task] = await db
    .insert(agentTasks)
    .values({
      entityId,
      orchestratorId: agentId,
      title,
      status,
      dependsOn,
    })
    .returning();
  return task!;
}

// ─── Tests ─────────────────────────────────────────────────────────────────────

describe('validateDependencies', () => {
  it('passes when depends_on is empty', async () => {
    await seedContext(db);
    const newTaskId = 'new-task-00' as TaskId;
    // Should not throw
    await expect(validateDependencies(newTaskId, [], db)).resolves.toBeUndefined();
  });

  it('passes when all referenced tasks exist', async () => {
    const { entityId, agentId } = await seedContext(db);
    const task1 = await createTask(db, entityId, agentId, 'Dep Task A');
    const newTaskId = 'new-task-01' as TaskId;
    await expect(
      validateDependencies(newTaskId, [task1.id as TaskId], db),
    ).resolves.toBeUndefined();
  });

  it('throws missing_dependency when referenced task does not exist', async () => {
    const newTaskId = 'new-task-02' as TaskId;
    const nonExistentId = '00000000-0000-0000-0000-000000000099' as TaskId;

    await expect(validateDependencies(newTaskId, [nonExistentId], db)).rejects.toThrow(
      OrchestrationError,
    );

    try {
      await validateDependencies(newTaskId, [nonExistentId], db);
    } catch (err) {
      const e = err as OrchestrationError;
      expect(e.code).toBe('missing_dependency');
    }
  });

  it('throws cycle_detected for direct cycle (A → B → A)', async () => {
    const { entityId, agentId } = await seedContext(db);
    // Create task B that will depend on task A
    // Then we test: newTask A trying to depend on B (which would create B → A → B cycle
    // since A depends on B and B depends on A)
    const taskB = await createTask(db, entityId, agentId, 'Cycle Task B', 'todo', []);
    const taskA = await createTask(db, entityId, agentId, 'Cycle Task A', 'todo', [taskB.id]);

    // Now update taskB to depend on taskA (creating a cycle)
    // We simulate by testing: newTaskId=taskB.id, dependsOn=[taskA.id]
    // taskA already depends on taskB, so taskB → taskA → taskB = cycle
    await expect(
      validateDependencies(taskB.id as TaskId, [taskA.id as TaskId], db),
    ).rejects.toThrow(OrchestrationError);
  });
});

describe('checkAllDepsResolved', () => {
  it('returns true when task has no dependencies', async () => {
    const { entityId, agentId } = await seedContext(db);
    const task = await createTask(db, entityId, agentId, 'No Deps Task');
    const result = await checkAllDepsResolved(task.id as TaskId, db);
    expect(result).toBe(true);
  });

  it('returns false when a dependency is still todo', async () => {
    const { entityId, agentId } = await seedContext(db);
    const dep = await createTask(db, entityId, agentId, 'Dep Still Todo', 'todo');
    const main = await createTask(db, entityId, agentId, 'Main Task', 'todo', [dep.id]);
    const result = await checkAllDepsResolved(main.id as TaskId, db);
    expect(result).toBe(false);
  });

  it('returns true when all dependencies are done', async () => {
    const { entityId, agentId } = await seedContext(db);
    const dep = await createTask(db, entityId, agentId, 'Dep Done', 'done');
    const main = await createTask(db, entityId, agentId, 'Main All Done', 'todo', [dep.id]);
    const result = await checkAllDepsResolved(main.id as TaskId, db);
    expect(result).toBe(true);
  });

  it('returns false when some deps done, some still todo', async () => {
    const { entityId, agentId } = await seedContext(db);
    const dep1 = await createTask(db, entityId, agentId, 'Dep 1 Done', 'done');
    const dep2 = await createTask(db, entityId, agentId, 'Dep 2 Todo', 'todo');
    const main = await createTask(db, entityId, agentId, 'Main Mixed Deps', 'todo', [
      dep1.id,
      dep2.id,
    ]);
    const result = await checkAllDepsResolved(main.id as TaskId, db);
    expect(result).toBe(false);
  });

  it('returns false for non-existent task', async () => {
    const result = await checkAllDepsResolved('00000000-0000-0000-0000-000000000098' as TaskId, db);
    expect(result).toBe(false);
  });
});
