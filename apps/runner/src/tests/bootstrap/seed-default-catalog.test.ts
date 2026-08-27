// seed-default-catalog.test.ts — regression for system-skill seeding: every
// install gets the same system skills out of the box, and user overrides are
// preserved on subsequent boots. Agents are NOT seeded — every agent is
// created by the user.

import { describe, it, expect, beforeAll } from 'vitest';
import { spinUpTestDb } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import { eq, count } from '@nodal-agents/db';
import { agentSkills, entities, users } from '@nodal-agents/db';
import { seedDefaultSkills } from '../../bootstrap/seed-default-skills.ts';
import { systemSkills } from '@nodal-agents/catalog';
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
  REFLECTION_ENABLED: 'false',
  REFLECTION_MAX_PER_HOUR: 6,
  REFLECTION_MAX_TURNS: 3,
  CURATOR_STALE_DAYS: 30,
  CURATOR_ARCHIVE_DAYS: 90,
  CURATOR_MIN_SKILLS: 5,
  CURATOR_INTERVAL_DAYS: 7,
  CURATOR_MAX_TURNS: 4,
  CURATOR_MEMORY_STALE_DAYS: 60,
  CURATOR_MEMORY_IMPORTANCE_MAX: 2,
  CURATOR_MEMORY_MIN: 8,
  MEMORY_CURATION_ENABLED: '',
  RETENTION_DAYS: 0,
  SKILL_UPDATE_CHECK_INTERVAL_HOURS: 24,
  SKILL_UPDATE_CHECK_BATCH_SIZE: 10,
  NODALAI_APPROVAL_GRACE_MS: 0,
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

  it('un skill de l’UTILISATEUR au slug du catalogue n’est jamais absorbé', async () => {
    // Depuis que `dev` est au catalogue, la collision est plausible : c'est un
    // nom court qu'une install a pu donner à son propre skill avant que le
    // slug soit réservé. Le seeder l'absorbait — contenu écrasé, et surtout
    // row re-tamponnée `createdBy='system'`, ce qui transformait un texte
    // utilisateur en skill système assignable depuis n'importe quel espace et
    // faisait de ses porteurs des développeurs.
    const { db: db2 } = await spinUpTestDb();
    const fixture = await seedSingleEntityFixture(db2);
    const monContenu = 'MON PROPRE SKILL DEV';
    await db2.insert(agentSkills).values({
      entityId: fixture.entityId,
      slug: 'dev',
      name: 'Mon dev à moi',
      content: monContenu,
      createdBy: 'user',
    });

    await seedDefaultSkills(db2, env);

    const rows = await db2
      .select({
        content: agentSkills.content,
        createdBy: agentSkills.createdBy,
      })
      .from(agentSkills)
      .where(eq(agentSkills.slug, 'dev'));

    // Une seule row, celle de l'utilisateur, intacte et toujours à lui.
    expect(rows, 'le seeder a dupliqué ou remplacé le skill de l’utilisateur').toHaveLength(1);
    expect(rows[0]!.content, 'le contenu de l’utilisateur a été écrasé').toBe(monContenu);
    expect(rows[0]!.createdBy, 'un contenu utilisateur a été promu « skill système »').toBe('user');
  });
});

describe('skill seeding guards', () => {
  it('bearer-token mode: skips seeding (multi-tenant safety)', async () => {
    const { db } = await spinUpTestDb();
    await seedSingleEntityFixture(db);
    const bearerEnv = { ...env, AUTH_MODE: 'bearer-token' as const };

    await seedDefaultSkills(db, bearerEnv);

    const skillRows = await db.select({ n: count() }).from(agentSkills);
    expect(skillRows[0]?.n).toBe(0);
  });

  it('no entity yet: skips seeding (fresh pre-signup boot)', async () => {
    const { db } = await spinUpTestDb();
    // No entity fixture — DB is empty.
    await seedDefaultSkills(db, env);

    const skillRows = await db.select({ n: count() }).from(agentSkills);
    expect(skillRows[0]?.n).toBe(0);
  });

  it('multi-entity: still seeds, into a single entity (oldest)', async () => {
    const { db } = await spinUpTestDb();
    await seedSingleEntityFixture(db);
    await seedSingleEntityFixture(db); // second entity
    await seedSingleEntityFixture(db); // third entity — mirrors a dirty local-auth DB

    await seedDefaultSkills(db, env);

    // Every system skill is seeded despite >1 entity (the old guard wrongly skipped).
    const skillRows = await db.select({ n: count() }).from(agentSkills);
    expect(skillRows[0]?.n).toBe(systemSkills.length);

    // All seeded rows belong to ONE entity (slug is globally unique → one
    // install-wide set of system skills).
    const owners = await db.select({ entityId: agentSkills.entityId }).from(agentSkills);
    const distinct = new Set(owners.map((r) => r.entityId));
    expect(distinct.size).toBe(1);
  });
});
