// planner/task-tools.test.ts — create_task and list_tasks DB tests

import { describe, it, expect, beforeAll } from 'vitest';
import { eq } from '@nodalai/db';
import { spinUpTestDb } from '@nodalai/db/test-utils';
import { agents, agentTasks, agentJobs } from '@nodalai/db';
import { generateTaskTools } from '../../planner/task-tools.js';
import type { AgentId } from '../../types.js';
import type { TestDb } from '@nodalai/db/test-utils';
import type { ToolContext } from '@nodalai/tools';

let db: TestDb;

beforeAll(async () => {
  const res = await spinUpTestDb();
  db = res.db;
});

// ─── Seed helpers ──────────────────────────────────────────────────────────────

async function seedContext(db: TestDb) {
  const [user] = await db
    .insert((await import('@nodalai/db')).users)
    .values({ email: `test-pt-${Date.now()}@ex.com` })
    .returning();
  const [entity] = await db
    .insert((await import('@nodalai/db')).entities)
    .values({ userId: user!.id, name: 'T', slug: `e-pt-${Date.now()}` })
    .returning();

  const [planner] = await db
    .insert(agents)
    .values({
      entityId: entity!.id,
      name: 'Test Planner',
      slug: `test-planner-${Date.now()}`,
      personality: 'p',
      role: 'orchestrator',
      active: true,
    })
    .returning();

  const [worker] = await db
    .insert(agents)
    .values({
      entityId: entity!.id,
      name: 'Test Worker P',
      slug: `test-worker-p-${Date.now()}`,
      personality: 'p',
      role: 'agent',
      active: true,
    })
    .returning();

  const [job] = await db
    .insert(agentJobs)
    .values({
      entityId: entity!.id,
      agentId: planner!.id,
      channel: 'api',
      task: 'planner job',
      status: 'processing',
    })
    .returning();

  return {
    entityId: entity!.id,
    plannerId: planner!.id,
    workerSlug: worker!.slug,
    workerId: worker!.id,
    jobId: job!.id,
  };
}

// ─── Tests ─────────────────────────────────────────────────────────────────────

describe('generateTaskTools', () => {
  it('returns [create_task, list_tasks]', () => {
    const tools = generateTaskTools('test-id' as AgentId, db);
    expect(tools).toHaveLength(2);
    expect(tools[0]?.name).toBe('create_task');
    expect(tools[1]?.name).toBe('list_tasks');
  });

  describe('create_task', () => {
    it('inserts a real row into agent_tasks', async () => {
      const { entityId, plannerId, workerSlug, jobId } = await seedContext(db);
      const [createTask] = generateTaskTools(plannerId as AgentId, db);
      const ctx: ToolContext = { jobId, agentId: plannerId, entityId, db };

      const result = await createTask!.execute(
        {
          title: 'Fetch inventory data',
          assigned_to: workerSlug,
          priority: 'high',
        },
        ctx,
      );

      expect(result.taskId).toBeDefined();
      expect(result.title).toBe('Fetch inventory data');

      // Verify the row exists in DB
      const [row] = await db
        .select({ id: agentTasks.id, title: agentTasks.title, priority: agentTasks.priority })
        .from(agentTasks)
        .where(eq(agentTasks.id, result.taskId));

      expect(row?.title).toBe('Fetch inventory data');
      expect(row?.priority).toBe('high');
    });

    it('assigns to agent by slug (resolves to agent_id)', async () => {
      const { entityId, plannerId, workerSlug, workerId, jobId } = await seedContext(db);
      const [createTask] = generateTaskTools(plannerId as AgentId, db);
      const ctx: ToolContext = { jobId, agentId: plannerId, entityId, db };

      const result = await createTask!.execute(
        { title: 'Slug test task', assigned_to: workerSlug },
        ctx,
      );

      const [row] = await db
        .select({ assignedAgentId: agentTasks.assignedAgentId })
        .from(agentTasks)
        .where(eq(agentTasks.id, result.taskId));

      expect(row?.assignedAgentId).toBe(workerId);
    });

    it('sets rootJobId from context', async () => {
      const { entityId, plannerId, workerSlug, jobId } = await seedContext(db);
      const [createTask] = generateTaskTools(plannerId as AgentId, db);
      const ctx: ToolContext = { jobId, agentId: plannerId, entityId, db };

      const result = await createTask!.execute(
        { title: 'Root job test', assigned_to: workerSlug },
        ctx,
      );

      const [row] = await db
        .select({ rootJobId: agentTasks.rootJobId })
        .from(agentTasks)
        .where(eq(agentTasks.id, result.taskId));

      expect(row?.rootJobId).toBe(jobId);
    });

    it('stores depends_on array', async () => {
      const { entityId, plannerId, workerSlug, jobId } = await seedContext(db);
      const [createTask] = generateTaskTools(plannerId as AgentId, db);
      const ctx: ToolContext = { jobId, agentId: plannerId, entityId, db };

      // Create first task
      const first = await createTask!.execute({ title: 'Task A', assigned_to: workerSlug }, ctx);

      // Create second task depending on first
      const second = await createTask!.execute(
        { title: 'Task B', assigned_to: workerSlug, depends_on: [first.taskId] },
        ctx,
      );

      const [row] = await db
        .select({ dependsOn: agentTasks.dependsOn })
        .from(agentTasks)
        .where(eq(agentTasks.id, second.taskId));

      expect(row?.dependsOn).toContain(first.taskId);
    });
  });

  describe('list_tasks', () => {
    it('returns tasks created in this job', async () => {
      const { entityId, plannerId, workerSlug, jobId } = await seedContext(db);
      const [createTask, listTasks] = generateTaskTools(plannerId as AgentId, db);
      const ctx: ToolContext = { jobId, agentId: plannerId, entityId, db };

      await createTask!.execute({ title: 'List Test Task 1', assigned_to: workerSlug }, ctx);
      await createTask!.execute({ title: 'List Test Task 2', assigned_to: workerSlug }, ctx);

      const tasks = await listTasks!.execute({}, ctx);
      expect(tasks.length).toBeGreaterThanOrEqual(2);
      const titles = tasks.map((t) => t.title);
      expect(titles).toContain('List Test Task 1');
      expect(titles).toContain('List Test Task 2');
    });

    it('resolves assigned agent_id to slug', async () => {
      const { entityId, plannerId, workerSlug, jobId } = await seedContext(db);
      const [createTask, listTasks] = generateTaskTools(plannerId as AgentId, db);
      const ctx: ToolContext = { jobId, agentId: plannerId, entityId, db };

      await createTask!.execute({ title: 'Slug resolution test', assigned_to: workerSlug }, ctx);

      const tasks = await listTasks!.execute({}, ctx);
      const task = tasks.find((t) => t.title === 'Slug resolution test');
      expect(task?.assignedTo).toBe(workerSlug);
    });

    it('filters by status when provided', async () => {
      const { entityId, plannerId, workerSlug, jobId } = await seedContext(db);
      const [createTask, listTasks] = generateTaskTools(plannerId as AgentId, db);
      const ctx: ToolContext = { jobId, agentId: plannerId, entityId, db };

      await createTask!.execute({ title: 'Status Filter Task', assigned_to: workerSlug }, ctx);

      // Only todo tasks
      const todoTasks = await listTasks!.execute({ status: 'todo' }, ctx);
      expect(todoTasks.every((t) => t.status === 'todo')).toBe(true);

      // No done tasks yet
      const doneTasks = await listTasks!.execute({ status: 'done' }, ctx);
      const created = doneTasks.find((t) => t.title === 'Status Filter Task');
      expect(created).toBeUndefined();
    });
  });
});
