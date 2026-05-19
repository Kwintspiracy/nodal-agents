// seed-default-catalog.test.ts — regression for the system-catalog-seeding
// brique (Quentin 2026-05-19): every install gets the same skills, agents,
// and default assignments out of the box, and user overrides are preserved
// on subsequent boots.

import { describe, it, expect, beforeAll } from 'vitest';
import { spinUpTestDb } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import { and, eq, count } from '@nodal-agents/db';
import {
  agents,
  agentSkills,
  agentSkillAssignments,
  entities,
  entityLlmKeys,
  users,
} from '@nodal-agents/db';
import { seedDefaultSkills } from '../../bootstrap/seed-default-skills.ts';
import { seedDefaultAgents } from '../../bootstrap/seed-default-agents.ts';
import { seedDefaultAssignments } from '../../bootstrap/seed-default-assignments.ts';
import { systemSkills, systemAgents, systemAssignments } from '../../bootstrap/catalog/index.ts';
import type { RunnerEnv } from '../../env.ts';

const env: RunnerEnv = {
  DATABASE_URL: 'test://local',
  LLM_PROVIDER: 'openai-compatible',
  LLM_MODEL: 'mock',
  LLM_API_KEY: 'k',
  LLM_BASE_URL: undefined,
  EMBEDDING_PROVIDER: 'keyword',
  EMBEDDING_MODEL: undefined,
  EMBEDDING_BASE_URL: undefined,
  AUTH_MODE: 'local-trust',
  WORKER_SECRET: 's',
  BEARER_TOKEN: undefined,
  PORT: 3099,
  BIND: '127.0.0.1',
  APP_URL: 'http://localhost:3099',
  NODE_ENV: 'test',
};

async function seedSingleEntityFixture(db: TestDb) {
  const [user] = await db
    .insert(users)
    .values({ email: `cat-${Date.now()}-${Math.random()}@test.com` })
    .returning();
  const [entity] = await db
    .insert(entities)
    .values({ userId: user!.id, name: 'TestEnt', slug: `e-cat-${Date.now()}-${Math.random()}` })
    .returning();
  return { userId: user!.id, entityId: entity!.id };
}

describe('seedDefaultSkills', () => {
  let db: TestDb;
  beforeAll(async () => {
    db = (await spinUpTestDb()).db;
  });

  it('fresh install: creates every system skill, content == default_content, overridden=false', async () => {
    await seedSingleEntityFixture(db);
    await seedDefaultSkills(db, env);

    for (const skill of systemSkills) {
      const [row] = await db
        .select({
          slug: agentSkills.slug,
          content: agentSkills.content,
          defaultContent: agentSkills.defaultContent,
          contentOverridden: agentSkills.contentOverridden,
        })
        .from(agentSkills)
        .where(eq(agentSkills.slug, skill.slug))
        .limit(1);
      expect(row).toBeDefined();
      expect(row?.content).toBe(skill.content);
      expect(row?.defaultContent).toBe(skill.content);
      expect(row?.contentOverridden).toBe(false);
    }
  });

  it('idempotent: running twice does not duplicate or corrupt', async () => {
    // db state from previous test = already seeded once
    await seedDefaultSkills(db, env);

    const rows = await db.select({ n: count() }).from(agentSkills);
    expect(rows[0]?.n).toBe(systemSkills.length);
  });

  it('user override preserved: existing skill with content_overridden=true keeps user content; only default_content refreshes', async () => {
    // Mark obsidian as user-edited with custom content
    const userContent = 'USER CUSTOM OBSIDIAN CONTENT';
    await db
      .update(agentSkills)
      .set({ content: userContent, contentOverridden: true })
      .where(eq(agentSkills.slug, 'obsidian'));

    await seedDefaultSkills(db, env);

    const [row] = await db
      .select({
        content: agentSkills.content,
        defaultContent: agentSkills.defaultContent,
        contentOverridden: agentSkills.contentOverridden,
      })
      .from(agentSkills)
      .where(eq(agentSkills.slug, 'obsidian'));
    expect(row?.content).toBe(userContent); // user override untouched
    expect(row?.defaultContent).toBe(systemSkills.find((s) => s.slug === 'obsidian')!.content); // default refreshed to latest canonical
    expect(row?.contentOverridden).toBe(true);
  });
});

describe('seedDefaultAgents', () => {
  it('fresh install: creates every system agent with systemAgent=true and canonical personality', async () => {
    const { db } = await spinUpTestDb();
    const { entityId } = await seedSingleEntityFixture(db);
    // Seed a default LLM key so resolveModel has something to wire to
    await db.insert(entityLlmKeys).values({
      entityId,
      provider: 'openrouter',
      apiKey: 'enc:test',
      apiKeyLast4: 'xxxx',
      defaultModel: 'deepseek/deepseek-v4-pro',
      isActive: true,
    });

    await seedDefaultAgents(db, env);

    for (const agent of systemAgents) {
      const [row] = await db
        .select({
          slug: agents.slug,
          personality: agents.personality,
          role: agents.role,
          orchestratorMode: agents.orchestratorMode,
          systemAgent: agents.systemAgent,
          model: agents.model,
        })
        .from(agents)
        .where(eq(agents.slug, agent.slug))
        .limit(1);
      expect(row).toBeDefined();
      expect(row?.personality).toBe(agent.personality);
      expect(row?.role).toBe(agent.role);
      expect(row?.orchestratorMode).toBe(agent.orchestratorMode ?? null);
      expect(row?.systemAgent).toBe(true);
      expect(row?.model).toBeTruthy();
    }
  });

  it('upgrade case: existing agent keeps user-edited personality untouched, structural fields updated', async () => {
    const { db } = await spinUpTestDb();
    const { entityId } = await seedSingleEntityFixture(db);
    await db.insert(entityLlmKeys).values({
      entityId,
      provider: 'openrouter',
      apiKey: 'enc:test',
      apiKeyLast4: 'xxxx',
      defaultModel: 'deepseek/deepseek-v4-pro',
      isActive: true,
    });
    // Pre-seed an agent with a user-edited personality + different role
    const customPersonality = 'I am a heavily customized concierge personality';
    await db.insert(agents).values({
      entityId,
      slug: 'concierge',
      name: 'Old Name',
      role: 'agent', // intentionally wrong, seeder should fix
      personality: customPersonality,
      model: 'old-model',
      systemAgent: false, // intentionally wrong, seeder should fix
      active: true,
    });

    await seedDefaultAgents(db, env);

    const [row] = await db
      .select({
        personality: agents.personality,
        role: agents.role,
        orchestratorMode: agents.orchestratorMode,
        systemAgent: agents.systemAgent,
        name: agents.name,
      })
      .from(agents)
      .where(eq(agents.slug, 'concierge'))
      .limit(1);
    expect(row?.personality).toBe(customPersonality); // user edit untouched
    expect(row?.role).toBe('orchestrator'); // structural updated
    expect(row?.orchestratorMode).toBe('router'); // structural updated
    expect(row?.systemAgent).toBe(true); // flag fixed
    expect(row?.name).toBe('Conciergus'); // structural updated
  });
});

describe('seedDefaultAssignments', () => {
  it('fresh install after skills+agents: creates every default assignment', async () => {
    const { db } = await spinUpTestDb();
    const { entityId } = await seedSingleEntityFixture(db);
    await db.insert(entityLlmKeys).values({
      entityId,
      provider: 'openrouter',
      apiKey: 'enc:test',
      apiKeyLast4: 'xxxx',
      defaultModel: 'deepseek/deepseek-v4-pro',
      isActive: true,
    });
    await seedDefaultSkills(db, env);
    await seedDefaultAgents(db, env);
    await seedDefaultAssignments(db, env);

    for (const link of systemAssignments) {
      const [agentRow] = await db
        .select({ id: agents.id })
        .from(agents)
        .where(eq(agents.slug, link.agentSlug));
      const [skillRow] = await db
        .select({ id: agentSkills.id })
        .from(agentSkills)
        .where(eq(agentSkills.slug, link.skillSlug));
      expect(agentRow).toBeDefined();
      expect(skillRow).toBeDefined();
      const [linkRow] = await db
        .select({ id: agentSkillAssignments.id })
        .from(agentSkillAssignments)
        .where(
          and(
            eq(agentSkillAssignments.agentId, agentRow!.id),
            eq(agentSkillAssignments.skillId, skillRow!.id),
          ),
        );
      expect(linkRow).toBeDefined();
    }
  });

  it('idempotent: re-running does not duplicate assignments', async () => {
    const { db } = await spinUpTestDb();
    const { entityId } = await seedSingleEntityFixture(db);
    await db.insert(entityLlmKeys).values({
      entityId,
      provider: 'openrouter',
      apiKey: 'enc:test',
      apiKeyLast4: 'xxxx',
      defaultModel: 'deepseek/deepseek-v4-pro',
      isActive: true,
    });
    await seedDefaultSkills(db, env);
    await seedDefaultAgents(db, env);
    await seedDefaultAssignments(db, env);
    const firstRows = await db.select({ n: count() }).from(agentSkillAssignments);
    const firstCount = firstRows[0]?.n ?? -1;

    await seedDefaultAssignments(db, env);
    const secondRows = await db.select({ n: count() }).from(agentSkillAssignments);
    const secondCount = secondRows[0]?.n ?? -2;

    expect(secondCount).toBe(firstCount);
  });
});

describe('catalog guards', () => {
  it('bearer-token mode: skips all seeding (multi-tenant safety)', async () => {
    const { db } = await spinUpTestDb();
    await seedSingleEntityFixture(db);
    const bearerEnv = { ...env, AUTH_MODE: 'bearer-token' as const };

    await seedDefaultSkills(db, bearerEnv);
    await seedDefaultAgents(db, bearerEnv);
    await seedDefaultAssignments(db, bearerEnv);

    const skillRows = await db.select({ n: count() }).from(agentSkills);
    const agentRows = await db.select({ n: count() }).from(agents);
    expect(skillRows[0]?.n).toBe(0);
    expect(agentRows[0]?.n).toBe(0);
  });

  it('multi-entity: skips all seeding (>1 entities = future multi-user, defer)', async () => {
    const { db } = await spinUpTestDb();
    await seedSingleEntityFixture(db);
    await seedSingleEntityFixture(db); // second entity

    await seedDefaultSkills(db, env);
    await seedDefaultAgents(db, env);
    await seedDefaultAssignments(db, env);

    const skillRows = await db.select({ n: count() }).from(agentSkills);
    const agentRows = await db.select({ n: count() }).from(agents);
    expect(skillRows[0]?.n).toBe(0);
    expect(agentRows[0]?.n).toBe(0);
  });
});
