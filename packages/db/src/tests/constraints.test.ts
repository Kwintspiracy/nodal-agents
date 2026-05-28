// Constraint tests — FK cascades, CHECK violations, UNIQUE violations

import { describe, it, expect, beforeAll } from 'vitest';
import { spinUpTestDb, seedMinimal } from './helpers.ts';
import type { TestDb } from './helpers.ts';
import { eq } from 'drizzle-orm';
import * as schema from '../schema/index.ts';

let db: TestDb;
let seed: { userId: string; entityId: string; agentId: string; jobId: string };

beforeAll(async () => {
  const result = await spinUpTestDb();
  db = result.db;
  seed = await seedMinimal(db);
});

// ── CHECK constraint violations ───────────────────────────────────────────────

describe('CHECK constraints', () => {
  it('agent_jobs: rejects invalid status', async () => {
    await expect(
      db.insert(schema.agentJobs).values({
        entityId: seed.entityId,
        agentId: seed.agentId,
        channel: 'api',
        task: 'test',
        status: 'invalid_status',
      }),
    ).rejects.toThrow();
  });

  it('agent_jobs: rejects invalid channel', async () => {
    await expect(
      db.insert(schema.agentJobs).values({
        entityId: seed.entityId,
        agentId: seed.agentId,
        channel: 'fax',
        task: 'test',
      }),
    ).rejects.toThrow();
  });

  it('agent_memory: rejects importance > 5', async () => {
    await expect(
      db.insert(schema.agentMemory).values({
        entityId: seed.entityId,
        agentId: seed.agentId,
        fact: 'test',
        importance: 6,
      }),
    ).rejects.toThrow();
  });

  it('agent_memory: rejects importance < 1', async () => {
    await expect(
      db.insert(schema.agentMemory).values({
        entityId: seed.entityId,
        agentId: seed.agentId,
        fact: 'test',
        importance: 0,
      }),
    ).rejects.toThrow();
  });

  it('agent_memory: rejects invalid category', async () => {
    await expect(
      db.insert(schema.agentMemory).values({
        entityId: seed.entityId,
        fact: 'test',
        category: 'invalid_category',
      }),
    ).rejects.toThrow();
  });

  it('agent_memory: rejects invalid source', async () => {
    await expect(
      db.insert(schema.agentMemory).values({
        entityId: seed.entityId,
        fact: 'test',
        source: 'robot',
      }),
    ).rejects.toThrow();
  });

  it('agents: rejects invalid role', async () => {
    await expect(
      db.insert(schema.agents).values({
        entityId: seed.entityId,
        name: 'Bad Agent',
        slug: `bad-role-${Date.now()}`,
        personality: 'bad',
        role: 'superuser',
      }),
    ).rejects.toThrow();
  });

  it('agents: rejects invalid orchestrator_mode', async () => {
    await expect(
      db.insert(schema.agents).values({
        entityId: seed.entityId,
        name: 'Bad Mode Agent',
        slug: `bad-mode-${Date.now()}`,
        personality: 'bad',
        orchestratorMode: 'dictator',
      }),
    ).rejects.toThrow();
  });

  it('approval_requests: rejects invalid status', async () => {
    await expect(
      db.insert(schema.approvalRequests).values({
        entityId: seed.entityId,
        jobId: seed.jobId,
        toolName: 'test',
        toolInput: {},
        status: 'maybe',
      }),
    ).rejects.toThrow();
  });

  it('approval_rules: rejects invalid action', async () => {
    await expect(
      db.insert(schema.approvalRules).values({
        entityId: seed.entityId,
        toolName: 'test',
        action: 'ignore',
      }),
    ).rejects.toThrow();
  });

  it('connectors: rejects invalid auth_type', async () => {
    await expect(
      db.insert(schema.connectors).values({
        entityId: seed.entityId,
        name: 'bad',
        slug: `bad-auth-${Date.now()}`,
        authType: 'magic',
      }),
    ).rejects.toThrow();
  });

  it('agent_tasks: rejects invalid status', async () => {
    await expect(
      db.insert(schema.agentTasks).values({
        entityId: seed.entityId,
        orchestratorId: seed.agentId,
        title: 'bad',
        status: 'waiting',
        priority: 'medium',
      }),
    ).rejects.toThrow();
  });

  it('agent_tasks: rejects invalid priority', async () => {
    await expect(
      db.insert(schema.agentTasks).values({
        entityId: seed.entityId,
        orchestratorId: seed.agentId,
        title: 'bad',
        status: 'todo',
        priority: 'extreme',
      }),
    ).rejects.toThrow();
  });

  it('agent_tasks: rejects title > 200 chars', async () => {
    await expect(
      db.insert(schema.agentTasks).values({
        entityId: seed.entityId,
        orchestratorId: seed.agentId,
        title: 'a'.repeat(201),
        status: 'todo',
        priority: 'medium',
      }),
    ).rejects.toThrow();
  });

  it('agent_schedules: rejects invalid type', async () => {
    await expect(
      db.insert(schema.agentSchedules).values({
        entityId: seed.entityId,
        agentId: seed.agentId,
        type: 'timer',
        name: 'bad schedule',
        cronExpr: '* * * * *',
      }),
    ).rejects.toThrow();
  });

  it('agent_runs: rejects invalid key_source', async () => {
    await expect(
      db.insert(schema.agentRuns).values({
        entityId: seed.entityId,
        agentId: seed.agentId,
        task: 'test',
        keySource: 'thirdparty',
      }),
    ).rejects.toThrow();
  });

  it('entity_members: rejects invalid role', async () => {
    const [extraUser] = await db
      .insert(schema.users)
      .values({ email: `member-role-${Date.now()}@example.com` })
      .returning();
    await expect(
      db.insert(schema.entityMembers).values({
        entityId: seed.entityId,
        userId: extraUser!.id,
        role: 'superadmin',
      }),
    ).rejects.toThrow();
  });
});

// ── FK CASCADE tests ──────────────────────────────────────────────────────────

describe('FK cascades', () => {
  it('deleting entity cascades to agents', async () => {
    // Create a disposable user + entity + agent
    const [u] = await db
      .insert(schema.users)
      .values({ email: `cascade-test-${Date.now()}@example.com` })
      .returning();
    const [e] = await db
      .insert(schema.entities)
      .values({
        userId: u!.id,
        name: 'Cascade Entity',
        slug: `cascade-entity-${Date.now()}`,
      })
      .returning();
    const [a] = await db
      .insert(schema.agents)
      .values({
        entityId: e!.id,
        name: 'Cascade Agent',
        slug: `cascade-agent-${Date.now()}`,
        personality: 'test',
      })
      .returning();

    // Delete entity → agent should be gone
    await db.delete(schema.entities).where(eq(schema.entities.id, e!.id));
    const gone = await db.select().from(schema.agents).where(eq(schema.agents.id, a!.id));
    expect(gone.length).toBe(0);
  });

  it('deleting job cascades to tool_calls', async () => {
    const [j] = await db
      .insert(schema.agentJobs)
      .values({
        entityId: seed.entityId,
        agentId: seed.agentId,
        channel: 'api',
        task: 'cascade job',
      })
      .returning();
    const [tc] = await db
      .insert(schema.toolCalls)
      .values({
        entityId: seed.entityId,
        jobId: j!.id,
        toolName: 'cascade_tool',
      })
      .returning();

    await db.delete(schema.agentJobs).where(eq(schema.agentJobs.id, j!.id));
    const gone = await db.select().from(schema.toolCalls).where(eq(schema.toolCalls.id, tc!.id));
    expect(gone.length).toBe(0);
  });

  it('deleting agent cascades to agent_skill_assignments', async () => {
    // New agent + skill + assignment
    const [a] = await db
      .insert(schema.agents)
      .values({
        entityId: seed.entityId,
        name: `Cascade Assign Agent ${Date.now()}`,
        slug: `cascade-assign-${Date.now()}`,
        personality: 'test',
      })
      .returning();
    const [sk] = await db
      .insert(schema.agentSkills)
      .values({
        entityId: seed.entityId,
        name: `Cascade Skill ${Date.now()}`,
        slug: `cascade-skill-${Date.now()}`,
        content: '# Cascade',
      })
      .returning();
    const [ssa] = await db
      .insert(schema.agentSkillAssignments)
      .values({
        entityId: seed.entityId,
        agentId: a!.id,
        skillId: sk!.id,
      })
      .returning();

    await db.delete(schema.agents).where(eq(schema.agents.id, a!.id));
    const gone = await db
      .select()
      .from(schema.agentSkillAssignments)
      .where(eq(schema.agentSkillAssignments.id, ssa!.id));
    expect(gone.length).toBe(0);
  });

  it('deleting agent cascades to agent_schedules', async () => {
    const [a] = await db
      .insert(schema.agents)
      .values({
        entityId: seed.entityId,
        name: `Cascade Sched Agent ${Date.now()}`,
        slug: `cascade-sched-agent-${Date.now()}`,
        personality: 'test',
      })
      .returning();
    const [s] = await db
      .insert(schema.agentSchedules)
      .values({
        entityId: seed.entityId,
        agentId: a!.id,
        type: 'cron',
        name: 'cascade sched',
        cronExpr: '0 * * * *',
      })
      .returning();

    await db.delete(schema.agents).where(eq(schema.agents.id, a!.id));
    const gone = await db
      .select()
      .from(schema.agentSchedules)
      .where(eq(schema.agentSchedules.id, s!.id));
    expect(gone.length).toBe(0);
  });

  it('deleting agent cascades through jobs, runs, memory, tasks (both FKs), approval_requests', async () => {
    // Live bug 2026-05-20 — clicking Delete on an agent surfaced a FK violation
    // toast. Five FK refs to agents.id were ON DELETE NO ACTION; migration 0013
    // flipped them all to CASCADE. Insert one dependent row in each table for a
    // disposable agent, then DELETE the agent and assert every row is gone.
    const [a] = await db
      .insert(schema.agents)
      .values({
        entityId: seed.entityId,
        name: `Sweep Agent ${Date.now()}`,
        slug: `sweep-agent-${Date.now()}`,
        personality: 'test',
      })
      .returning();

    const [j] = await db
      .insert(schema.agentJobs)
      .values({
        entityId: seed.entityId,
        agentId: a!.id,
        channel: 'api',
        task: 'sweep job',
      })
      .returning();
    const [r] = await db
      .insert(schema.agentRuns)
      .values({
        entityId: seed.entityId,
        agentId: a!.id,
        task: 'sweep run',
      })
      .returning();
    const [m] = await db
      .insert(schema.agentMemory)
      .values({
        entityId: seed.entityId,
        agentId: a!.id,
        fact: 'sweep memory',
      })
      .returning();
    const [tCreated] = await db
      .insert(schema.agentTasks)
      .values({
        entityId: seed.entityId,
        orchestratorId: seed.agentId,
        title: 'sweep task created-by',
        createdByAgentId: a!.id,
      })
      .returning();
    const [tAssigned] = await db
      .insert(schema.agentTasks)
      .values({
        entityId: seed.entityId,
        orchestratorId: seed.agentId,
        title: 'sweep task assigned-to',
        assignedAgentId: a!.id,
      })
      .returning();
    const [ar] = await db
      .insert(schema.approvalRequests)
      .values({
        entityId: seed.entityId,
        jobId: j!.id,
        agentId: a!.id,
        toolName: 'sweep_tool',
        toolInput: {},
      })
      .returning();

    await db.delete(schema.agents).where(eq(schema.agents.id, a!.id));

    expect(
      await db.select().from(schema.agentJobs).where(eq(schema.agentJobs.id, j!.id)),
    ).toHaveLength(0);
    expect(
      await db.select().from(schema.agentRuns).where(eq(schema.agentRuns.id, r!.id)),
    ).toHaveLength(0);
    expect(
      await db.select().from(schema.agentMemory).where(eq(schema.agentMemory.id, m!.id)),
    ).toHaveLength(0);
    expect(
      await db.select().from(schema.agentTasks).where(eq(schema.agentTasks.id, tCreated!.id)),
    ).toHaveLength(0);
    expect(
      await db.select().from(schema.agentTasks).where(eq(schema.agentTasks.id, tAssigned!.id)),
    ).toHaveLength(0);
    expect(
      await db.select().from(schema.approvalRequests).where(eq(schema.approvalRequests.id, ar!.id)),
    ).toHaveLength(0);
  });

  it('deleting job sets agent_tasks.job_id to NULL (set null)', async () => {
    const [j] = await db
      .insert(schema.agentJobs)
      .values({
        entityId: seed.entityId,
        agentId: seed.agentId,
        channel: 'api',
        task: 'setnull job',
      })
      .returning();
    const [t] = await db
      .insert(schema.agentTasks)
      .values({
        entityId: seed.entityId,
        orchestratorId: seed.agentId,
        title: 'setnull task',
        jobId: j!.id,
      })
      .returning();

    await db.delete(schema.agentJobs).where(eq(schema.agentJobs.id, j!.id));
    const found = await db.select().from(schema.agentTasks).where(eq(schema.agentTasks.id, t!.id));
    expect(found[0]?.jobId).toBeNull();
  });
});

// ── UNIQUE constraint violations ──────────────────────────────────────────────

describe('UNIQUE constraints', () => {
  it('entities: rejects duplicate slug', async () => {
    const slug = `unique-slug-${Date.now()}`;
    await db.insert(schema.entities).values({ userId: seed.userId, name: 'E1', slug });
    await expect(
      db.insert(schema.entities).values({ userId: seed.userId, name: 'E2', slug }),
    ).rejects.toThrow();
  });

  it('agents: rejects duplicate slug', async () => {
    const slug = `unique-agent-${Date.now()}`;
    await db
      .insert(schema.agents)
      .values({ entityId: seed.entityId, name: 'A1', slug, personality: 'test' });
    await expect(
      db
        .insert(schema.agents)
        .values({ entityId: seed.entityId, name: 'A2', slug, personality: 'test' }),
    ).rejects.toThrow();
  });

  it('agent_mcp_servers: rejects a duplicate (agent_id, mcp_server_id)', async () => {
    // Backs the assign/unassign UPSERT — without this unique index the
    // onConflictDoUpdate in setAgentMcpServerAssignmentAction throws.
    const [ms] = await db
      .insert(schema.mcpServers)
      .values({
        entityId: seed.entityId,
        name: 'Assign-unique MCP',
        slug: `assign-uniq-mcp-${Date.now()}`,
        transport: 'http',
        url: 'https://mcp.example.com',
      })
      .returning();
    await db.insert(schema.agentMcpServers).values({
      entityId: seed.entityId,
      agentId: seed.agentId,
      mcpServerId: ms!.id,
    });
    await expect(
      db.insert(schema.agentMcpServers).values({
        entityId: seed.entityId,
        agentId: seed.agentId,
        mcpServerId: ms!.id,
      }),
    ).rejects.toThrow();
  });

  it('connectors: allows same slug for different entities (composite unique)', async () => {
    const slug = `shared-slug-${Date.now()}`;

    // entity A — create a separate user + entity
    const [userA] = await db
      .insert(schema.users)
      .values({ email: `entity-a-${Date.now()}@example.com` })
      .returning();
    const [entityA] = await db
      .insert(schema.entities)
      .values({ userId: userA!.id, name: 'Entity A', slug: `entity-a-${Date.now()}` })
      .returning();

    // entity B — another user + entity
    const [userB] = await db
      .insert(schema.users)
      .values({ email: `entity-b-${Date.now()}@example.com` })
      .returning();
    const [entityB] = await db
      .insert(schema.entities)
      .values({ userId: userB!.id, name: 'Entity B', slug: `entity-b-${Date.now()}` })
      .returning();

    // Insert connector for entity A — must succeed
    const [connA] = await db
      .insert(schema.connectors)
      .values({ entityId: entityA!.id, name: 'C-A', slug, authType: 'oauth2' })
      .returning();
    expect(connA).toBeDefined();

    // Insert same slug for entity B — must also succeed (different entity)
    const [connB] = await db
      .insert(schema.connectors)
      .values({ entityId: entityB!.id, name: 'C-B', slug, authType: 'oauth2' })
      .returning();
    expect(connB).toBeDefined();

    // Insert same slug for entity A again — must fail with the composite constraint name
    try {
      await db
        .insert(schema.connectors)
        .values({ entityId: entityA!.id, name: 'C-A-dup', slug, authType: 'oauth2' });
      expect.fail('Expected duplicate-key error but insert succeeded');
    } catch (err: unknown) {
      // Drizzle 0.45 wraps the original pg error in `cause` (the top-level
      // message is just the failing SQL). Check both layers so we don't
      // depend on which one carries the constraint detail.
      const topMsg = err instanceof Error ? err.message : String(err);
      const cause = err instanceof Error ? err.cause : null;
      const causeMsg = cause instanceof Error ? cause.message : String(cause ?? '');
      expect(`${topMsg}\n${causeMsg}`).toMatch(/connectors_entity_slug_unique/);
    }
  });

  it('entity_llm_keys: allows multiple rows per (entity_id, provider) — Brique 24', async () => {
    // Multi-LLM management (Brique 24) intentionally drops the old unique
    // constraint so users can register e.g. one Anthropic key for prod and
    // another for dev under the same entity.
    const provider = `test-provider-${Date.now()}`;
    const [first] = await db
      .insert(schema.entityLlmKeys)
      .values({
        entityId: seed.entityId,
        provider,
        apiKey: 'key1',
        nickname: 'prod',
      })
      .returning();
    const [second] = await db
      .insert(schema.entityLlmKeys)
      .values({
        entityId: seed.entityId,
        provider,
        apiKey: 'key2',
        nickname: 'dev',
      })
      .returning();
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expect(first?.id).not.toBe(second?.id);
  });

  it('agent_skill_assignments: rejects duplicate (agent_id, skill_id)', async () => {
    const [sk] = await db
      .insert(schema.agentSkills)
      .values({
        entityId: seed.entityId,
        name: `Unique Skill Assign ${Date.now()}`,
        slug: `unique-skill-assign-${Date.now()}`,
        content: '# test',
      })
      .returning();
    await db
      .insert(schema.agentSkillAssignments)
      .values({ entityId: seed.entityId, agentId: seed.agentId, skillId: sk!.id });
    await expect(
      db
        .insert(schema.agentSkillAssignments)
        .values({ entityId: seed.entityId, agentId: seed.agentId, skillId: sk!.id }),
    ).rejects.toThrow();
  });
});
