// planner/task-tools.test.ts — create_task and list_tasks DB tests

import { describe, it, expect, beforeAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from '@nodal-agents/db';
import { spinUpTestDb } from '@nodal-agents/db/test-utils';
import {
  agents,
  agentTasks,
  agentJobs,
  agentSkills,
  agentSkillAssignments,
} from '@nodal-agents/db';
import { generateTaskTools } from '../../planner/task-tools';
import type { AgentId } from '../../types';
import type { TestDb } from '@nodal-agents/db/test-utils';
import type { ToolContext } from '@nodal-agents/tools';

let db: TestDb;

beforeAll(async () => {
  const res = await spinUpTestDb();
  db = res.db;
});

// ─── Seed helpers ──────────────────────────────────────────────────────────────

async function seedContext(db: TestDb) {
  const [user] = await db
    .insert((await import('@nodal-agents/db')).users)
    .values({ email: `test-pt-${Date.now()}@ex.com` })
    .returning();
  const [entity] = await db
    .insert((await import('@nodal-agents/db')).entities)
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
      const ctx: ToolContext = { jobId, agentId: plannerId, entityId, db, jobChatId: null };

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
      const ctx: ToolContext = { jobId, agentId: plannerId, entityId, db, jobChatId: null };

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

    it('does NOT assign to an agent slug from a different entity', async () => {
      const { entityId, plannerId, jobId } = await seedContext(db);
      // Seed a second entity with an agent whose slug the planner does not own.
      const [otherUser] = await db
        .insert((await import('@nodal-agents/db')).users)
        .values({ email: `test-pt-other-${Date.now()}@ex.com` })
        .returning();
      const [otherEntity] = await db
        .insert((await import('@nodal-agents/db')).entities)
        .values({ userId: otherUser!.id, name: 'Other', slug: `e-pt-other-${Date.now()}` })
        .returning();
      const [foreignAgent] = await db
        .insert(agents)
        .values({
          entityId: otherEntity!.id,
          name: 'Foreign Agent',
          slug: `foreign-agent-${Date.now()}`,
          personality: 'p',
          role: 'agent',
          active: true,
        })
        .returning();

      const [createTask] = generateTaskTools(plannerId as AgentId, db);
      const ctx: ToolContext = { jobId, agentId: plannerId, entityId, db, jobChatId: null };

      const result = await createTask!.execute(
        { title: 'Cross-entity assignment attempt', assigned_to: foreignAgent!.slug },
        ctx,
      );

      const [row] = await db
        .select({ assignedAgentId: agentTasks.assignedAgentId })
        .from(agentTasks)
        .where(eq(agentTasks.id, result.taskId));

      // The foreign agent's slug must not resolve — task created unassigned.
      expect(row?.assignedAgentId).toBeNull();
    });

    it('sets rootJobId from context', async () => {
      const { entityId, plannerId, workerSlug, jobId } = await seedContext(db);
      const [createTask] = generateTaskTools(plannerId as AgentId, db);
      const ctx: ToolContext = { jobId, agentId: plannerId, entityId, db, jobChatId: null };

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
      const ctx: ToolContext = { jobId, agentId: plannerId, entityId, db, jobChatId: null };

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

    it('rejects depends_on referencing a non-existent task ID and creates no row', async () => {
      const { entityId, plannerId, workerSlug, jobId } = await seedContext(db);
      const [createTask] = generateTaskTools(plannerId as AgentId, db);
      const ctx: ToolContext = { jobId, agentId: plannerId, entityId, db, jobChatId: null };

      const ghostId = randomUUID();

      // C1 (audit followup): a hallucinated/typo'd dependency ID must reject
      // the creation loud, not insert a task that freezes forever waiting on
      // a dependency that will never resolve.
      await expect(
        createTask!.execute(
          { title: 'Depends on ghost', assigned_to: workerSlug, depends_on: [ghostId] },
          ctx,
        ),
      ).rejects.toThrow(/missing_dependency/);

      const rows = await db
        .select({ id: agentTasks.id })
        .from(agentTasks)
        .where(eq(agentTasks.title, 'Depends on ghost'));
      expect(rows).toHaveLength(0);
    });

    it('rejects depends_on that would join a dependency cycle and creates no row', async () => {
      const { entityId, plannerId, workerSlug, jobId } = await seedContext(db);
      const [createTask] = generateTaskTools(plannerId as AgentId, db);
      const ctx: ToolContext = { jobId, agentId: plannerId, entityId, db, jobChatId: null };

      // Simulate a pre-existing cycle between two tasks: `depends_on` is a
      // plain uuid[] with no FK/cycle enforcement, so nothing stops two rows
      // from referencing each other directly (e.g. legacy data, or a bug in
      // a path other than create_task). A new task depending on both must
      // still be rejected.
      const idX = randomUUID();
      const idY = randomUUID();
      await db.insert(agentTasks).values({
        id: idX,
        entityId,
        orchestratorId: plannerId,
        title: 'Cyclic X',
        dependsOn: [idY],
      });
      await db.insert(agentTasks).values({
        id: idY,
        entityId,
        orchestratorId: plannerId,
        title: 'Cyclic Y',
        dependsOn: [idX],
      });

      await expect(
        createTask!.execute(
          { title: 'Joins the cycle', assigned_to: workerSlug, depends_on: [idX, idY] },
          ctx,
        ),
      ).rejects.toThrow(/cycle_detected/);

      const rows = await db
        .select({ id: agentTasks.id })
        .from(agentTasks)
        .where(eq(agentTasks.title, 'Joins the cycle'));
      expect(rows).toHaveLength(0);
    });

    it('rejects depends_on referencing a task from a DIFFERENT entity', async () => {
      // F1 (audit followup): dependency resolution must be entity-scoped, like
      // assigned_to already is. A cross-entity ref is treated as non-existent —
      // this closes a cross-tenant existence oracle AND stops an entity-A task
      // from freezing forever on an entity-B task it can never observe finish.
      const { entityId, plannerId, workerSlug, jobId } = await seedContext(db);

      // Seed a second entity and a task inside it.
      const [otherUser] = await db
        .insert((await import('@nodal-agents/db')).users)
        .values({ email: `test-pt-dep-other-${Date.now()}@ex.com` })
        .returning();
      const [otherEntity] = await db
        .insert((await import('@nodal-agents/db')).entities)
        .values({ userId: otherUser!.id, name: 'OtherDep', slug: `e-pt-dep-other-${Date.now()}` })
        .returning();
      const foreignTaskId = randomUUID();
      await db.insert(agentTasks).values({
        id: foreignTaskId,
        entityId: otherEntity!.id,
        orchestratorId: plannerId,
        title: 'Foreign entity task',
      });

      const [createTask] = generateTaskTools(plannerId as AgentId, db);
      const ctx: ToolContext = { jobId, agentId: plannerId, entityId, db, jobChatId: null };

      // The foreign task EXISTS in the DB, but not in this entity → must reject
      // as missing_dependency (not leak its existence, not create a frozen row).
      await expect(
        createTask!.execute(
          { title: 'Depends across tenant', assigned_to: workerSlug, depends_on: [foreignTaskId] },
          ctx,
        ),
      ).rejects.toThrow(/missing_dependency/);

      const rows = await db
        .select({ id: agentTasks.id })
        .from(agentTasks)
        .where(eq(agentTasks.title, 'Depends across tenant'));
      expect(rows).toHaveLength(0);
    });

    it('schema rejects a non-UUID dependency id and an over-long depends_on', async () => {
      // F3 (audit followup): depends_on is validated at the tool boundary
      // (executeTool parses inputSchema before execute runs). A typo'd,
      // non-UUID id must surface as a clean validation error — not a raw
      // Postgres "invalid input syntax for type uuid" from the id column — and
      // the array is bounded to cap a fan-out DoS.
      const [createTask] = generateTaskTools('planner-x' as AgentId, db);

      const nonUuid = createTask!.inputSchema.safeParse({
        title: 'Bad dep id',
        assigned_to: 'w',
        depends_on: ['not-a-uuid'],
      });
      expect(nonUuid.success).toBe(false);

      const tooMany = createTask!.inputSchema.safeParse({
        title: 'Too many deps',
        assigned_to: 'w',
        depends_on: Array.from({ length: 51 }, () => randomUUID()),
      });
      expect(tooMany.success).toBe(false);

      const ok = createTask!.inputSchema.safeParse({
        title: 'Fine',
        assigned_to: 'w',
        depends_on: [randomUUID(), randomUUID()],
      });
      expect(ok.success).toBe(true);
    });

    // ─── B2 (audit#2 followup): brief validation ────────────────────────────

    it('B2: warns when the brief names a tool the target will NOT have', async () => {
      const { entityId, plannerId, workerSlug, jobId } = await seedContext(db);
      const [createTask] = generateTaskTools(plannerId as AgentId, db);
      const ctx: ToolContext = { jobId, agentId: plannerId, entityId, db, jobChatId: null };

      const result = await createTask!.execute(
        {
          title: 'Deliver the chart',
          description: 'Generate the chart, then call send_image to deliver it to the user.',
          assigned_to: workerSlug,
        },
        ctx,
      );

      expect(result.warning).toBeDefined();
      expect(result.warning).toContain('send_image');
      expect(result.warning).toContain(workerSlug);
      // Non-blocking: the task is still created.
      const [row] = await db
        .select({ id: agentTasks.id })
        .from(agentTasks)
        .where(eq(agentTasks.id, result.taskId));
      expect(row?.id).toBe(result.taskId);
    });

    it('B2: does NOT warn when the brief mentions no tool at all', async () => {
      const { entityId, plannerId, workerSlug, jobId } = await seedContext(db);
      const [createTask] = generateTaskTools(plannerId as AgentId, db);
      const ctx: ToolContext = { jobId, agentId: plannerId, entityId, db, jobChatId: null };

      const result = await createTask!.execute(
        {
          title: 'Research task',
          description: 'Research the top 5 competitors and summarize their pricing.',
          assigned_to: workerSlug,
        },
        ctx,
      );

      expect(result.warning).toBeUndefined();
    });

    it('B2: does NOT warn when the mentioned tool IS available to the target', async () => {
      const { entityId, plannerId, workerSlug, workerId, jobId } = await seedContext(db);
      const [skill] = await db
        .insert(agentSkills)
        .values({
          entityId,
          name: 'Office Skill',
          slug: `office-skill-tt-${Date.now()}`,
          content: 'c',
          requiredBuiltins: ['office_write_docx'],
        })
        .returning();
      await db
        .insert(agentSkillAssignments)
        .values({ entityId, agentId: workerId, skillId: skill!.id });

      const [createTask] = generateTaskTools(plannerId as AgentId, db);
      const ctx: ToolContext = { jobId, agentId: plannerId, entityId, db, jobChatId: null };

      const result = await createTask!.execute(
        {
          title: 'Write the report',
          description: 'Call office_write_docx to produce the report.',
          assigned_to: workerSlug,
        },
        ctx,
      );

      expect(result.warning).toBeUndefined();
    });
  });

  describe('list_tasks', () => {
    it('returns tasks created in this job', async () => {
      const { entityId, plannerId, workerSlug, jobId } = await seedContext(db);
      const [createTask, listTasks] = generateTaskTools(plannerId as AgentId, db);
      const ctx: ToolContext = { jobId, agentId: plannerId, entityId, db, jobChatId: null };

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
      const ctx: ToolContext = { jobId, agentId: plannerId, entityId, db, jobChatId: null };

      await createTask!.execute({ title: 'Slug resolution test', assigned_to: workerSlug }, ctx);

      const tasks = await listTasks!.execute({}, ctx);
      const task = tasks.find((t) => t.title === 'Slug resolution test');
      expect(task?.assignedTo).toBe(workerSlug);
    });

    it('filters by status when provided', async () => {
      const { entityId, plannerId, workerSlug, jobId } = await seedContext(db);
      const [createTask, listTasks] = generateTaskTools(plannerId as AgentId, db);
      const ctx: ToolContext = { jobId, agentId: plannerId, entityId, db, jobChatId: null };

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
