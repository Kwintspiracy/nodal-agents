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

  it('conversations: rejects invalid origin (migration 0065)', async () => {
    await expect(
      db.insert(schema.conversations).values({
        entityId: seed.entityId,
        agentId: seed.agentId,
        origin: 'imported',
      }),
    ).rejects.toThrow();
  });

  it('conversations: defaults origin to "user" when omitted', async () => {
    const [row] = await db
      .insert(schema.conversations)
      .values({ entityId: seed.entityId, agentId: seed.agentId })
      .returning();
    expect(row?.origin).toBe('user');
  });
});

// ── code_projects.verify_commands (migration 0088) ────────────────────────────

describe('code_projects.verify_commands CHECK (0088)', () => {
  it('rejects 6 entries (max is 5, v5-A)', async () => {
    await expect(
      db.insert(schema.codeProjects).values({
        entityId: seed.entityId,
        projectPath: `/srv/verify-6-${Date.now()}`,
        projectKey: `/srv/verify-6-${Date.now()}`,
        verifyCommands: Array.from({ length: 6 }, (_, i) => ({
          command: `echo ${i}`,
          timeoutSeconds: 5,
        })),
      }),
    ).rejects.toThrow();
  });

  it('rejects 0 entries (empty array)', async () => {
    await expect(
      db.insert(schema.codeProjects).values({
        entityId: seed.entityId,
        projectPath: `/srv/verify-0-${Date.now()}`,
        projectKey: `/srv/verify-0-${Date.now()}`,
        verifyCommands: [],
      }),
    ).rejects.toThrow();
  });

  it('rejects a non-array value', async () => {
    // Deliberately the wrong shape (a bare object, not an array) to exercise
    // the CHECK's jsonb_typeof(...) = 'array' branch — cast past the column's
    // VerifyCommand[] type since the DB, not TypeScript, is what's under test.
    const notAnArray = { command: 'pnpm test', timeoutSeconds: 60 } as unknown as Array<{
      command: string;
      timeoutSeconds: number;
    }>;
    await expect(
      db.insert(schema.codeProjects).values({
        entityId: seed.entityId,
        projectPath: `/srv/verify-obj-${Date.now()}`,
        projectKey: `/srv/verify-obj-${Date.now()}`,
        verifyCommands: notAnArray,
      }),
    ).rejects.toThrow();
  });

  it('accepts 1 to 5 entries and NULL (not_configured)', async () => {
    const [oneCmd] = await db
      .insert(schema.codeProjects)
      .values({
        entityId: seed.entityId,
        projectPath: `/srv/verify-1-${Date.now()}`,
        projectKey: `/srv/verify-1-${Date.now()}`,
        verifyCommands: [{ command: 'pnpm test', timeoutSeconds: 60 }],
      })
      .returning();
    expect(oneCmd?.verifyCommands).toHaveLength(1);

    const [noCmd] = await db
      .insert(schema.codeProjects)
      .values({
        entityId: seed.entityId,
        projectPath: `/srv/verify-null-${Date.now()}`,
        projectKey: `/srv/verify-null-${Date.now()}`,
      })
      .returning();
    expect(noCmd?.verifyCommands).toBeNull();
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

  it('deleting a schedule sets agent_jobs.schedule_id to NULL and the job survives (Event Triggers, Brique 1)', async () => {
    const [s] = await db
      .insert(schema.agentSchedules)
      .values({
        entityId: seed.entityId,
        agentId: seed.agentId,
        type: 'cron',
        name: 'trigger-context sched',
        cronExpr: '0 * * * *',
      })
      .returning();
    const [j] = await db
      .insert(schema.agentJobs)
      .values({
        entityId: seed.entityId,
        agentId: seed.agentId,
        channel: 'cron',
        task: 'watch for changes',
        scheduleId: s!.id,
        triggerContext: {
          type: 'cron',
          scheduleName: 'trigger-context sched',
          prevRunAt: null,
        },
      })
      .returning();

    // Round-trip: scheduleId + the trigger_context jsonb come back exactly as
    // written (not just "truthy" — the actual jsonb content matters here since
    // the runner reads prevRunAt out of it to build the system prompt).
    const [before] = await db.select().from(schema.agentJobs).where(eq(schema.agentJobs.id, j!.id));
    expect(before!.scheduleId).toBe(s!.id);
    expect(before!.triggerContext).toEqual({
      type: 'cron',
      scheduleName: 'trigger-context sched',
      prevRunAt: null,
    });

    await db.delete(schema.agentSchedules).where(eq(schema.agentSchedules.id, s!.id));

    const [after] = await db.select().from(schema.agentJobs).where(eq(schema.agentJobs.id, j!.id));
    expect(after).toBeDefined(); // the job survives — ON DELETE SET NULL, not CASCADE
    expect(after!.scheduleId).toBeNull();
    // trigger_context is untouched — it's a point-in-time snapshot, not a live FK.
    expect(after!.triggerContext).toEqual({
      type: 'cron',
      scheduleName: 'trigger-context sched',
      prevRunAt: null,
    });
  });

  it('deleting agent cascades through jobs, memory, tasks (both FKs), approval_requests', async () => {
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

  it('agents: allows the same slug in two different entities — F-6, audit #2', async () => {
    // Previously slug was UNIQUE GLOBALLY: a 2nd entity/workspace creating an
    // agent with a slug already used by ANY other entity crashed the insert.
    // Composite (entity_id, slug) fixes this — prove both rows coexist.
    const slug = `shared-agent-slug-${Date.now()}`;
    const [otherUser] = await db
      .insert(schema.users)
      .values({ email: `f6-agent-user-${Date.now()}@example.com` })
      .returning();
    const [otherEntity] = await db
      .insert(schema.entities)
      .values({ userId: otherUser!.id, name: 'F-6 Other Entity', slug: `f6-other-${Date.now()}` })
      .returning();

    const [agentA] = await db
      .insert(schema.agents)
      .values({ entityId: seed.entityId, name: 'Shared Slug A', slug, personality: 'test' })
      .returning();
    const [agentB] = await db
      .insert(schema.agents)
      .values({ entityId: otherEntity!.id, name: 'Shared Slug B', slug, personality: 'test' })
      .returning();

    expect(agentA).toBeDefined();
    expect(agentB).toBeDefined();
    expect(agentA?.id).not.toBe(agentB?.id);

    const rows = await db.select().from(schema.agents).where(eq(schema.agents.slug, slug));
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.id).sort()).toEqual([agentA!.id, agentB!.id].sort());
  });

  it('agent_skills: rejects duplicate slug within the same entity — F-6, audit #2', async () => {
    const slug = `unique-skill-slug-${Date.now()}`;
    await db.insert(schema.agentSkills).values({
      entityId: seed.entityId,
      name: `Unique Skill Slug A ${Date.now()}`,
      slug,
      content: '# A',
    });
    await expect(
      db.insert(schema.agentSkills).values({
        entityId: seed.entityId,
        name: `Unique Skill Slug B ${Date.now()}`,
        slug,
        content: '# B',
      }),
    ).rejects.toThrow();
  });

  it('agent_skills: rejects duplicate name within the same entity — F-6, audit #2', async () => {
    const name = `Unique Skill Name ${Date.now()}`;
    await db.insert(schema.agentSkills).values({
      entityId: seed.entityId,
      name,
      slug: `unique-skill-name-a-${Date.now()}`,
      content: '# A',
    });
    await expect(
      db.insert(schema.agentSkills).values({
        entityId: seed.entityId,
        name,
        slug: `unique-skill-name-b-${Date.now()}`,
        content: '# B',
      }),
    ).rejects.toThrow();
  });

  it('agent_skills: allows the same slug AND name in two different entities — F-6, audit #2', async () => {
    // The exact crash this fix closes: two entities/workspaces installing the
    // same community skill (same slug, same display name) must both succeed.
    const slug = `shared-skill-slug-${Date.now()}`;
    const name = `Shared Skill Name ${Date.now()}`;
    const [otherUser] = await db
      .insert(schema.users)
      .values({ email: `f6-skill-user-${Date.now()}@example.com` })
      .returning();
    const [otherEntity] = await db
      .insert(schema.entities)
      .values({ userId: otherUser!.id, name: 'F-6 Skill Entity', slug: `f6-skill-e-${Date.now()}` })
      .returning();

    const [skillA] = await db
      .insert(schema.agentSkills)
      .values({ entityId: seed.entityId, name, slug, content: '# A' })
      .returning();
    const [skillB] = await db
      .insert(schema.agentSkills)
      .values({ entityId: otherEntity!.id, name, slug, content: '# B' })
      .returning();

    expect(skillA).toBeDefined();
    expect(skillB).toBeDefined();
    expect(skillA?.id).not.toBe(skillB?.id);

    const rows = await db
      .select()
      .from(schema.agentSkills)
      .where(eq(schema.agentSkills.slug, slug));
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.id).sort()).toEqual([skillA!.id, skillB!.id].sort());
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

  it('connectors: allows multiple instances with the same slug in the same entity — migration 0016', async () => {
    // Multi-instance brique (migration 0016) dropped the old (entity_id, slug)
    // UNIQUE constraint so an entity can hold several connectors of the same
    // type (e.g. several Gmail accounts). Prove both rows coexist.
    const slug = `shared-slug-${Date.now()}`;

    const [connA] = await db
      .insert(schema.connectors)
      .values({ entityId: seed.entityId, name: 'C-A', slug, authType: 'oauth2' })
      .returning();
    const [connB] = await db
      .insert(schema.connectors)
      .values({ entityId: seed.entityId, name: 'C-B', slug, authType: 'oauth2' })
      .returning();

    expect(connA).toBeDefined();
    expect(connB).toBeDefined();
    expect(connA?.id).not.toBe(connB?.id);

    const rows = await db.select().from(schema.connectors).where(eq(schema.connectors.slug, slug));
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.id).sort()).toEqual([connA!.id, connB!.id].sort());
  });

  it('connectors: rejects an exact duplicate (entity_id, slug, name) — migration 0072, 2026-07-22 incident', async () => {
    // A stuttering agent call (create_connector fired 8x with no existence
    // check) created 8 identical rows: same entity, same slug ("tavily"), same
    // name ("Tavily Search"). Migration 0072 closes exactly that shape.
    const slug = `dup-exact-slug-${Date.now()}`;
    const name = 'Tavily Search';
    await db.insert(schema.connectors).values({
      entityId: seed.entityId,
      name,
      slug,
      authType: 'api_key',
    });
    await expect(
      db.insert(schema.connectors).values({
        entityId: seed.entityId,
        name, // identical name
        slug, // identical slug
        authType: 'api_key',
      }),
    ).rejects.toThrow();

    // Confirm only the original row exists — the duplicate insert was actually
    // rejected, not silently coerced/ignored.
    const rows = await db.select().from(schema.connectors).where(eq(schema.connectors.slug, slug));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.name).toBe(name);
  });

  it('connectors: allows the SAME slug with a DIFFERENT name in the same entity — migration 0072 preserves 0016 multi-instance', async () => {
    // 0072 keys on (entity_id, slug, name), not (entity_id, slug) alone — a
    // second Gmail-type connector with a different display name must still be
    // insertable, exactly the multi-instance design 0016 protects.
    const slug = `dup-slug-diff-name-${Date.now()}`;
    const [connA] = await db
      .insert(schema.connectors)
      .values({ entityId: seed.entityId, name: 'Gmail — Work', slug, authType: 'oauth2' })
      .returning();
    const [connB] = await db
      .insert(schema.connectors)
      .values({ entityId: seed.entityId, name: 'Gmail — Personal', slug, authType: 'oauth2' })
      .returning();

    expect(connA).toBeDefined();
    expect(connB).toBeDefined();
    expect(connA?.id).not.toBe(connB?.id);

    const rows = await db.select().from(schema.connectors).where(eq(schema.connectors.slug, slug));
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.name).sort()).toEqual(['Gmail — Personal', 'Gmail — Work']);
  });

  it('mcp_servers: allows multiple instances with the same slug in the same entity — migration 0017', async () => {
    // Multi-instance brique (migration 0017) dropped the old (entity_id, slug)
    // UNIQUE index so an entity can register several MCP servers of the same
    // type (e.g. two Cogni Cortex accounts). Prove both rows coexist.
    const slug = `shared-mcp-slug-${Date.now()}`;

    const [msA] = await db
      .insert(schema.mcpServers)
      .values({
        entityId: seed.entityId,
        name: 'MCP-A',
        slug,
        transport: 'http',
        url: 'https://mcp-a.example.com',
      })
      .returning();
    const [msB] = await db
      .insert(schema.mcpServers)
      .values({
        entityId: seed.entityId,
        name: 'MCP-B',
        slug,
        transport: 'http',
        url: 'https://mcp-b.example.com',
      })
      .returning();

    expect(msA).toBeDefined();
    expect(msB).toBeDefined();
    expect(msA?.id).not.toBe(msB?.id);

    const rows = await db.select().from(schema.mcpServers).where(eq(schema.mcpServers.slug, slug));
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.id).sort()).toEqual([msA!.id, msB!.id].sort());
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

  it('agent_assignments: rejects duplicate (orchestrator_id, sub_agent_id) — F-18, audit #2', async () => {
    const [orch] = await db
      .insert(schema.agents)
      .values({
        entityId: seed.entityId,
        name: `Unique Assign Orch ${Date.now()}`,
        slug: `unique-assign-orch-${Date.now()}`,
        personality: 'test',
        role: 'orchestrator',
      })
      .returning();
    const [sub] = await db
      .insert(schema.agents)
      .values({
        entityId: seed.entityId,
        name: `Unique Assign Sub ${Date.now()}`,
        slug: `unique-assign-sub-${Date.now()}`,
        personality: 'test',
      })
      .returning();
    await db.insert(schema.agentAssignments).values({
      entityId: seed.entityId,
      orchestratorId: orch!.id,
      subAgentId: sub!.id,
    });
    await expect(
      db.insert(schema.agentAssignments).values({
        entityId: seed.entityId,
        orchestratorId: orch!.id,
        subAgentId: sub!.id,
      }),
    ).rejects.toThrow();
  });

  it('approval_rules: rejects duplicate (entity_id, agent_id, tool_name) — DB-1, audit #2', async () => {
    const toolName = `unique-approval-tool-${Date.now()}`;
    await db.insert(schema.approvalRules).values({
      entityId: seed.entityId,
      agentId: seed.agentId,
      toolName,
      action: 'require_approval',
    });
    await expect(
      db.insert(schema.approvalRules).values({
        entityId: seed.entityId,
        agentId: seed.agentId,
        toolName,
        action: 'block',
      }),
    ).rejects.toThrow();
  });

  it('approval_rules: rejects duplicate (entity_id, NULL agent_id, tool_name) — NULLS NOT DISTINCT, DB-1', async () => {
    // agentId=NULL marks an entity-wide rule (e.g. the run_command LAN
    // master-switch). A plain UNIQUE treats two NULLs as distinct and would
    // silently let a second, divergent entity-wide rule back in — this is
    // exactly the gap NULLS NOT DISTINCT (PG15+) closes.
    const toolName = `unique-approval-wide-tool-${Date.now()}`;
    await db.insert(schema.approvalRules).values({
      entityId: seed.entityId,
      agentId: null,
      toolName,
      action: 'auto_approve',
    });
    await expect(
      db.insert(schema.approvalRules).values({
        entityId: seed.entityId,
        agentId: null,
        toolName,
        action: 'require_approval',
      }),
    ).rejects.toThrow();
  });

  it('mcp_connections: rejects duplicate (entity_id, slug) — R5, audit #2 follow-up', async () => {
    const slug = `unique-mcp-conn-${Date.now()}`;
    await db.insert(schema.mcpConnections).values({
      entityId: seed.entityId,
      slug,
    });
    await expect(
      db.insert(schema.mcpConnections).values({
        entityId: seed.entityId,
        slug,
      }),
    ).rejects.toThrow();
  });

  it('entity_members: rejects duplicate (entity_id, user_id) — found sweeping helpers.ts for R5, audit #2 follow-up', async () => {
    const [extraUser] = await db
      .insert(schema.users)
      .values({ email: `dup-member-${Date.now()}@example.com` })
      .returning();
    await db
      .insert(schema.entityMembers)
      .values({ entityId: seed.entityId, userId: extraUser!.id, role: 'member' });
    await expect(
      db
        .insert(schema.entityMembers)
        .values({ entityId: seed.entityId, userId: extraUser!.id, role: 'admin' }),
    ).rejects.toThrow();
  });
});

// ── job_deliveries (migration 0090) ───────────────────────────────────────────

describe('job_deliveries constraints (0090)', () => {
  it('rejects attempts = 4 (CHECK attempts <= 3)', async () => {
    await expect(
      db.insert(schema.jobDeliveries).values({
        jobId: seed.jobId,
        channel: 'telegram',
        chatId: 'chat-1',
        payload: 'hi',
        outcome: 'attempted',
        idempotencyKey: `attempts4-${Date.now()}`,
        attempts: 4,
      }),
    ).rejects.toThrow();
  });

  it('accepts attempts = 3 (boundary, not off-by-one)', async () => {
    const [row] = await db
      .insert(schema.jobDeliveries)
      .values({
        jobId: seed.jobId,
        channel: 'telegram',
        chatId: 'chat-1',
        payload: 'hi',
        outcome: 'attempted',
        idempotencyKey: `attempts3-${Date.now()}`,
        attempts: 3,
      })
      .returning();
    expect(row?.attempts).toBe(3);
  });

  it('rejects a duplicate idempotency_key', async () => {
    const key = `dup-idem-${Date.now()}`;
    await db.insert(schema.jobDeliveries).values({
      jobId: seed.jobId,
      channel: 'telegram',
      chatId: 'chat-1',
      payload: 'hi',
      outcome: 'prepared',
      idempotencyKey: key,
    });
    await expect(
      db.insert(schema.jobDeliveries).values({
        jobId: seed.jobId,
        channel: 'telegram',
        chatId: 'chat-2',
        payload: 'again',
        outcome: 'prepared',
        idempotencyKey: key,
      }),
    ).rejects.toThrow();
  });

  it('rejects an outcome outside the enum', async () => {
    await expect(
      db.insert(schema.jobDeliveries).values({
        jobId: seed.jobId,
        channel: 'telegram',
        chatId: 'chat-1',
        payload: 'hi',
        outcome: 'sent',
        idempotencyKey: `bad-outcome-${Date.now()}`,
      }),
    ).rejects.toThrow();
  });

  it("rejects channel 'cron' — job_deliveries.channel is TRANSPORT, not agent_jobs.channel's ORIGIN vocabulary", async () => {
    await expect(
      db.insert(schema.jobDeliveries).values({
        jobId: seed.jobId,
        channel: 'cron',
        chatId: 'chat-1',
        payload: 'hi',
        outcome: 'prepared',
        idempotencyKey: `bad-channel-${Date.now()}`,
      }),
    ).rejects.toThrow();
  });

  it('cascade: deleting the job deletes its job_deliveries row', async () => {
    const [j] = await db
      .insert(schema.agentJobs)
      .values({
        entityId: seed.entityId,
        agentId: seed.agentId,
        channel: 'api',
        task: 'delivery cascade job',
      })
      .returning();
    const [d] = await db
      .insert(schema.jobDeliveries)
      .values({
        jobId: j!.id,
        channel: 'telegram',
        chatId: 'chat-1',
        payload: 'hi',
        outcome: 'prepared',
        idempotencyKey: `cascade-${Date.now()}`,
      })
      .returning();

    await db.delete(schema.agentJobs).where(eq(schema.agentJobs.id, j!.id));
    const gone = await db
      .select()
      .from(schema.jobDeliveries)
      .where(eq(schema.jobDeliveries.id, d!.id));
    expect(gone.length).toBe(0);
  });
});

// ── job_deliverable_verification_state + verification_runs (migration 0089) ──

describe('job_deliverable_verification_state + verification_runs constraints (0089)', () => {
  it('rejects verified_generation > dirty_generation', async () => {
    await expect(
      db.insert(schema.jobDeliverableVerificationState).values({
        jobId: seed.jobId,
        deliverableType: 'code_project',
        canonicalKey: `/srv/gen-check-${Date.now()}`,
        dirtyGeneration: 2,
        verifiedGeneration: 3,
        decisionStatus: 'dirty',
      }),
    ).rejects.toThrow();
  });

  it('accepts verified_generation === dirty_generation (boundary)', async () => {
    const [row] = await db
      .insert(schema.jobDeliverableVerificationState)
      .values({
        jobId: seed.jobId,
        deliverableType: 'code_project',
        canonicalKey: `/srv/gen-eq-${Date.now()}`,
        dirtyGeneration: 2,
        verifiedGeneration: 2,
        decisionStatus: 'green',
      })
      .returning();
    expect(row?.verifiedGeneration).toBe(2);
  });

  it('rejects a mutable type (code_project) carrying an outcome', async () => {
    await expect(
      db.insert(schema.jobDeliverableVerificationState).values({
        jobId: seed.jobId,
        deliverableType: 'code_project',
        canonicalKey: `/srv/mutable-outcome-${Date.now()}`,
        dirtyGeneration: 1,
        outcome: 'confirmed',
        decisionStatus: 'dirty',
      }),
    ).rejects.toThrow();
  });

  it('rejects an outbound_action row with no outcome', async () => {
    await expect(
      db.insert(schema.jobDeliverableVerificationState).values({
        jobId: seed.jobId,
        deliverableType: 'outbound_action',
        canonicalKey: `telegram:chat:${Date.now()}`,
        decisionStatus: 'not_configured',
      }),
    ).rejects.toThrow();
  });

  it('rejects an outbound_action row carrying a dirty_generation', async () => {
    await expect(
      db.insert(schema.jobDeliverableVerificationState).values({
        jobId: seed.jobId,
        deliverableType: 'outbound_action',
        canonicalKey: `telegram:chat:${Date.now()}`,
        outcome: 'prepared',
        dirtyGeneration: 1,
        decisionStatus: 'not_configured',
      }),
    ).rejects.toThrow();
  });

  it('accepts a well-formed outbound_action row', async () => {
    const [row] = await db
      .insert(schema.jobDeliverableVerificationState)
      .values({
        jobId: seed.jobId,
        deliverableType: 'outbound_action',
        canonicalKey: `telegram:chat:${Date.now()}`,
        outcome: 'prepared',
        decisionStatus: 'not_configured',
      })
      .returning();
    expect(row?.outcome).toBe('prepared');
    expect(row?.dirtyGeneration).toBeNull();
  });

  it('rejects a duplicate (job_id, deliverable_type, canonical_key)', async () => {
    const key = `/srv/dup-state-${Date.now()}`;
    await db.insert(schema.jobDeliverableVerificationState).values({
      jobId: seed.jobId,
      deliverableType: 'code_project',
      canonicalKey: key,
      dirtyGeneration: 1,
      decisionStatus: 'dirty',
    });
    await expect(
      db.insert(schema.jobDeliverableVerificationState).values({
        jobId: seed.jobId,
        deliverableType: 'code_project',
        canonicalKey: key,
        dirtyGeneration: 1,
        decisionStatus: 'dirty',
      }),
    ).rejects.toThrow();
  });

  it('verification_runs: rejects a verdict outside the enum', async () => {
    await expect(
      db.insert(schema.verificationRuns).values({
        jobId: seed.jobId,
        entityId: seed.entityId,
        deliverableType: 'code_project',
        canonicalKey: `/srv/bad-verdict-${Date.now()}`,
        sequenceId: crypto.randomUUID(),
        commandRank: 0,
        command: 'pnpm test',
        outcomeKind: 'exit',
        verdict: 'yellow',
      }),
    ).rejects.toThrow();
  });

  it('deleting the job cascades the state row but the run survives with job_id NULL', async () => {
    const [j] = await db
      .insert(schema.agentJobs)
      .values({
        entityId: seed.entityId,
        agentId: seed.agentId,
        channel: 'api',
        task: 'verification cascade job',
      })
      .returning();
    const [state] = await db
      .insert(schema.jobDeliverableVerificationState)
      .values({
        jobId: j!.id,
        deliverableType: 'code_project',
        canonicalKey: `/srv/cascade-${Date.now()}`,
        dirtyGeneration: 1,
        decisionStatus: 'dirty',
      })
      .returning();
    const [run] = await db
      .insert(schema.verificationRuns)
      .values({
        jobId: j!.id,
        entityId: seed.entityId,
        deliverableType: 'code_project',
        canonicalKey: `/srv/cascade-${Date.now()}`,
        sequenceId: crypto.randomUUID(),
        commandRank: 0,
        command: 'pnpm test',
        outcomeKind: 'exit',
        exitCode: 0,
        verdict: 'green',
      })
      .returning();

    await db.delete(schema.agentJobs).where(eq(schema.agentJobs.id, j!.id));

    const goneState = await db
      .select()
      .from(schema.jobDeliverableVerificationState)
      .where(eq(schema.jobDeliverableVerificationState.id, state!.id));
    expect(goneState.length).toBe(0);

    const survivingRun = await db
      .select()
      .from(schema.verificationRuns)
      .where(eq(schema.verificationRuns.id, run!.id));
    expect(survivingRun).toHaveLength(1);
    expect(survivingRun[0]?.jobId).toBeNull();
  });
});
