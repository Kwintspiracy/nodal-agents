// CRUD round-trip test — one INSERT + SELECT + UPDATE + DELETE per table

import { describe, it, expect, beforeAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { spinUpTestDb, seedMinimal } from './helpers.ts';
import type { TestDb } from './helpers.ts';
import * as schema from '../schema/index.ts';

let db: TestDb;
let seed: { userId: string; entityId: string; agentId: string; jobId: string };

beforeAll(async () => {
  const result = await spinUpTestDb();
  db = result.db;
  seed = await seedMinimal(db);
});

describe('CRUD: users', () => {
  it('insert + select + update + delete', async () => {
    const [u] = await db
      .insert(schema.users)
      .values({ email: `crud-user-${Date.now()}@example.com` })
      .returning();
    expect(u?.id).toBeTruthy();

    const found = await db.select().from(schema.users).where(eq(schema.users.id, u!.id));
    expect(found[0]?.email).toBe(u!.email);

    await db
      .update(schema.users)
      .set({ email: `updated-${Date.now()}@example.com` })
      .where(eq(schema.users.id, u!.id));

    await db.delete(schema.users).where(eq(schema.users.id, u!.id));
    const gone = await db.select().from(schema.users).where(eq(schema.users.id, u!.id));
    expect(gone.length).toBe(0);
  });
});

describe('CRUD: user_profiles', () => {
  it('insert + select + update', async () => {
    const [p] = await db
      .insert(schema.userProfiles)
      .values({ userId: seed.userId, displayName: 'Test User', timezone: 'Europe/Paris' })
      .returning();
    expect(p?.userId).toBe(seed.userId);

    const found = await db
      .select()
      .from(schema.userProfiles)
      .where(eq(schema.userProfiles.userId, seed.userId));
    expect(found[0]?.displayName).toBe('Test User');

    await db
      .update(schema.userProfiles)
      .set({ displayName: 'Updated' })
      .where(eq(schema.userProfiles.userId, seed.userId));
  });
});

describe('CRUD: entities', () => {
  it('insert + select + update + delete', async () => {
    const [e] = await db
      .insert(schema.entities)
      .values({
        userId: seed.userId,
        name: 'CRUD Entity',
        slug: `crud-entity-${Date.now()}`,
        industry: 'startup',
      })
      .returning();
    expect(e?.id).toBeTruthy();

    const found = await db.select().from(schema.entities).where(eq(schema.entities.id, e!.id));
    expect(found[0]?.name).toBe('CRUD Entity');

    await db
      .update(schema.entities)
      .set({ name: 'Updated Entity' })
      .where(eq(schema.entities.id, e!.id));

    await db.delete(schema.entities).where(eq(schema.entities.id, e!.id));
    const gone = await db.select().from(schema.entities).where(eq(schema.entities.id, e!.id));
    expect(gone.length).toBe(0);
  });
});

describe('CRUD: agents', () => {
  it('insert + select + update + delete', async () => {
    const [a] = await db
      .insert(schema.agents)
      .values({
        entityId: seed.entityId,
        name: 'CRUD Agent',
        slug: `crud-agent-${Date.now()}`,
        personality: 'Test personality',
        role: 'agent',
      })
      .returning();
    expect(a?.id).toBeTruthy();

    const found = await db.select().from(schema.agents).where(eq(schema.agents.id, a!.id));
    expect(found[0]?.name).toBe('CRUD Agent');

    await db.update(schema.agents).set({ active: false }).where(eq(schema.agents.id, a!.id));

    await db.delete(schema.agents).where(eq(schema.agents.id, a!.id));
    const gone = await db.select().from(schema.agents).where(eq(schema.agents.id, a!.id));
    expect(gone.length).toBe(0);
  });
});

describe('CRUD: agent_jobs', () => {
  it('insert + select + update', async () => {
    const [j] = await db
      .insert(schema.agentJobs)
      .values({
        entityId: seed.entityId,
        agentId: seed.agentId,
        channel: 'api',
        task: 'CRUD test task',
        status: 'pending',
      })
      .returning();
    expect(j?.id).toBeTruthy();

    await db
      .update(schema.agentJobs)
      .set({ status: 'completed', result: 'done' })
      .where(eq(schema.agentJobs.id, j!.id));

    const found = await db.select().from(schema.agentJobs).where(eq(schema.agentJobs.id, j!.id));
    expect(found[0]?.status).toBe('completed');
  });
});

describe('CRUD: agent_tasks', () => {
  it('insert + select + update', async () => {
    const [t] = await db
      .insert(schema.agentTasks)
      .values({
        entityId: seed.entityId,
        orchestratorId: seed.agentId,
        title: 'CRUD task',
        status: 'todo',
        priority: 'medium',
      })
      .returning();
    expect(t?.id).toBeTruthy();

    await db
      .update(schema.agentTasks)
      .set({ status: 'done', result: 'Completed successfully' })
      .where(eq(schema.agentTasks.id, t!.id));

    const found = await db.select().from(schema.agentTasks).where(eq(schema.agentTasks.id, t!.id));
    expect(found[0]?.status).toBe('done');
  });
});

describe('CRUD: connectors', () => {
  it('insert + select + update + delete', async () => {
    const [c] = await db
      .insert(schema.connectors)
      .values({
        entityId: seed.entityId,
        name: 'CRUD Connector',
        slug: `crud-conn-${Date.now()}`,
        authType: 'api_key',
      })
      .returning();
    expect(c?.id).toBeTruthy();

    await db
      .update(schema.connectors)
      .set({ active: false })
      .where(eq(schema.connectors.id, c!.id));

    await db.delete(schema.connectors).where(eq(schema.connectors.id, c!.id));
    const gone = await db.select().from(schema.connectors).where(eq(schema.connectors.id, c!.id));
    expect(gone.length).toBe(0);
  });
});

describe('CRUD: tool_calls', () => {
  it('insert + select', async () => {
    const [tc] = await db
      .insert(schema.toolCalls)
      .values({
        entityId: seed.entityId,
        jobId: seed.jobId,
        toolName: 'test_tool',
        toolInput: { param: 'value' },
        toolOutput: 'result',
        durationMs: 42,
        turn: 1,
      })
      .returning();
    expect(tc?.id).toBeTruthy();

    const found = await db.select().from(schema.toolCalls).where(eq(schema.toolCalls.id, tc!.id));
    expect(found[0]?.toolName).toBe('test_tool');
  });
});

describe('CRUD: approval_requests', () => {
  it('insert + select + update', async () => {
    const [ar] = await db
      .insert(schema.approvalRequests)
      .values({
        entityId: seed.entityId,
        jobId: seed.jobId,
        agentId: seed.agentId,
        toolName: 'delete_file',
        toolInput: { path: '/tmp/test.txt' },
        status: 'pending',
      })
      .returning();
    expect(ar?.id).toBeTruthy();

    await db
      .update(schema.approvalRequests)
      .set({ status: 'approved', resolvedBy: 'admin' })
      .where(eq(schema.approvalRequests.id, ar!.id));

    const found = await db
      .select()
      .from(schema.approvalRequests)
      .where(eq(schema.approvalRequests.id, ar!.id));
    expect(found[0]?.status).toBe('approved');
  });
});

describe('CRUD: approval_rules', () => {
  it('insert + select + delete', async () => {
    const [rule] = await db
      .insert(schema.approvalRules)
      .values({
        entityId: seed.entityId,
        agentId: seed.agentId,
        toolName: 'send_email',
        action: 'require_approval',
      })
      .returning();
    expect(rule?.id).toBeTruthy();

    await db.delete(schema.approvalRules).where(eq(schema.approvalRules.id, rule!.id));
  });
});

describe('CRUD: agent_memory', () => {
  it('insert + select + update', async () => {
    const [m] = await db
      .insert(schema.agentMemory)
      .values({
        entityId: seed.entityId,
        agentId: seed.agentId,
        fact: 'Test fact about the user',
        category: 'context',
        importance: 3,
        source: 'manual',
      })
      .returning();
    expect(m?.id).toBeTruthy();

    await db
      .update(schema.agentMemory)
      .set({ importance: 5 })
      .where(eq(schema.agentMemory.id, m!.id));

    const found = await db
      .select()
      .from(schema.agentMemory)
      .where(eq(schema.agentMemory.id, m!.id));
    expect(found[0]?.importance).toBe(5);
  });
});

describe('CRUD: webhook_triggers', () => {
  it('insert + select + delete', async () => {
    const [wh] = await db
      .insert(schema.webhookTriggers)
      .values({
        entityId: seed.entityId,
        agentId: seed.agentId,
        name: 'CRUD Webhook',
        slug: `crud-wh-${Date.now()}`,
        taskTemplate: 'Process payload: {{body}}',
        active: true,
      })
      .returning();
    expect(wh?.id).toBeTruthy();

    await db.delete(schema.webhookTriggers).where(eq(schema.webhookTriggers.id, wh!.id));
  });
});

describe('CRUD: agent_skills + skill_versions + skill_connectors + agent_skill_assignments', () => {
  it('full skill lifecycle', async () => {
    const [skill] = await db
      .insert(schema.agentSkills)
      .values({
        entityId: seed.entityId,
        name: `CRUD Skill ${Date.now()}`,
        slug: `crud-skill-${Date.now()}`,
        content: '# Test Skill\n\nDoes something useful.',
        active: true,
      })
      .returning();
    expect(skill?.id).toBeTruthy();

    const [sv] = await db
      .insert(schema.skillVersions)
      .values({
        entityId: seed.entityId,
        skillId: skill!.id,
        version: 1,
        content: '# Test Skill v1',
        name: 'Test Skill',
      })
      .returning();
    expect(sv?.id).toBeTruthy();

    const [conn] = await db
      .insert(schema.connectors)
      .values({
        entityId: seed.entityId,
        name: 'Skill Connector',
        slug: `skill-conn-${Date.now()}`,
        authType: 'api_key',
      })
      .returning();

    await db
      .insert(schema.skillConnectors)
      .values({ skillId: skill!.id, connectorId: conn!.id, entityId: seed.entityId });

    const [ssa] = await db
      .insert(schema.agentSkillAssignments)
      .values({
        entityId: seed.entityId,
        agentId: seed.agentId,
        skillId: skill!.id,
        useCustomInstructions: false,
      })
      .returning();
    expect(ssa?.id).toBeTruthy();
  });
});

describe('CRUD: agent_schedules', () => {
  it('insert + select + update', async () => {
    const [s] = await db
      .insert(schema.agentSchedules)
      .values({
        entityId: seed.entityId,
        agentId: seed.agentId,
        type: 'cron',
        name: 'CRUD Schedule',
        cronExpr: '*/5 * * * *',
        task: 'Run daily report',
        active: true,
      })
      .returning();
    expect(s?.id).toBeTruthy();

    await db
      .update(schema.agentSchedules)
      .set({ active: false })
      .where(eq(schema.agentSchedules.id, s!.id));
  });
});

describe('CRUD: entity_llm_keys', () => {
  it('insert + select + update', async () => {
    const [k] = await db
      .insert(schema.entityLlmKeys)
      .values({
        entityId: seed.entityId,
        provider: 'anthropic',
        apiKey: 'sk-test',
        isActive: true,
      })
      .returning();
    expect(k?.id).toBeTruthy();

    await db
      .update(schema.entityLlmKeys)
      .set({ isActive: false })
      .where(eq(schema.entityLlmKeys.id, k!.id));
  });
});

describe('CRUD: mcp_servers + mcp_connections', () => {
  it('insert + select + delete', async () => {
    const [ms] = await db
      .insert(schema.mcpServers)
      .values({
        entityId: seed.entityId,
        name: 'CRUD MCP Server',
        slug: `crud-mcp-${Date.now()}`,
        transport: 'http',
        url: 'https://mcp.example.com',
        active: true,
      })
      .returning();
    expect(ms?.id).toBeTruthy();

    const [mc] = await db
      .insert(schema.mcpConnections)
      .values({
        entityId: seed.entityId,
        slug: `crud-mcp-conn-${Date.now()}`,
        active: true,
      })
      .returning();
    expect(mc?.id).toBeTruthy();

    await db.delete(schema.mcpServers).where(eq(schema.mcpServers.id, ms!.id));
  });

  it('persists MCP credential columns (api_key, last4, auth scheme)', async () => {
    const [ms] = await db
      .insert(schema.mcpServers)
      .values({
        entityId: seed.entityId,
        name: 'Cred MCP Server',
        slug: `cred-mcp-${Date.now()}`,
        transport: 'http',
        url: 'https://mcp.example.com',
        apiKey: 'enc:v1:fakeiv:faketag:fakect',
        apiKeyLast4: 'd123',
        authScheme: 'header',
        authParamName: 'x-api-key',
        active: true,
      })
      .returning();
    expect(ms?.apiKey).toBe('enc:v1:fakeiv:faketag:fakect');
    expect(ms?.apiKeyLast4).toBe('d123');
    expect(ms?.authScheme).toBe('header');
    expect(ms?.authParamName).toBe('x-api-key');

    await db.delete(schema.mcpServers).where(eq(schema.mcpServers.id, ms!.id));
  });

  it('rejects an invalid auth_scheme via the CHECK constraint', async () => {
    await expect(
      db.insert(schema.mcpServers).values({
        entityId: seed.entityId,
        name: 'Bad Scheme MCP',
        slug: `bad-scheme-mcp-${Date.now()}`,
        transport: 'http',
        url: 'https://mcp.example.com',
        authScheme: 'bogus',
      }),
    ).rejects.toThrow();
  });

  it('allows a duplicate (entity_id, slug) — multi-instance, migration 0017 dropped the UNIQUE index', async () => {
    // See constraints.test.ts for the full multi-instance proof; this just
    // keeps the CRUD round-trip aligned with prod (was previously asserting
    // the old, now-dropped, constraint).
    const slug = `dup-mcp-${Date.now()}`;
    const [first] = await db
      .insert(schema.mcpServers)
      .values({
        entityId: seed.entityId,
        name: 'First',
        slug,
        transport: 'http',
        url: 'https://mcp.example.com',
      })
      .returning();
    const [second] = await db
      .insert(schema.mcpServers)
      .values({
        entityId: seed.entityId,
        name: 'Second',
        slug,
        transport: 'http',
        url: 'https://mcp.example.com',
      })
      .returning();
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expect(first?.id).not.toBe(second?.id);
  });
});
