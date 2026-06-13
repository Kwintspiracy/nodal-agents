// seed-llm-key.test.ts — Brique 25 seeder guard logic
//
// Tests:
//   1. local-auth single-user → seeds correctly (the case Quentin hit)
//   2. local-auth multi-user  → skips (>1 entities)
//   3. local-trust            → unchanged behavior (seeds for the single entity)

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomBytes } from 'node:crypto';
import { spinUpTestDb } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import { eq, count } from '@nodal-agents/db';
import { entityLlmKeys, agents, entities, users } from '@nodal-agents/db';
import {
  _setMasterKeyForTests,
  _resetMasterKeyCacheForTests,
  decrypt,
} from '@nodal-agents/secrets';
import { seedDefaultLlmKey } from '../../bootstrap/seed-llm-key.ts';
import type { RunnerEnv } from '../../env.ts';

// Inject a deterministic test master key so the seeder's encrypt() call doesn't
// touch the real ~/.nodalai/secrets.key. Reset between runs.
beforeAll(() => {
  _setMasterKeyForTests(randomBytes(32));
});
afterAll(() => {
  _resetMasterKeyCacheForTests();
});

function makeEnv(
  authMode: RunnerEnv['AUTH_MODE'],
  provider = 'openai-compatible',
  model = 'test-model',
): RunnerEnv {
  return {
    DATABASE_URL: 'test://local',
    LLM_PROVIDER: provider as RunnerEnv['LLM_PROVIDER'],
    LLM_MODEL: model,
    LLM_API_KEY: 'test-key',
    LLM_BASE_URL: 'http://localhost:11434',
    EMBEDDING_PROVIDER: 'keyword',
    EMBEDDING_MODEL: undefined,
    EMBEDDING_BASE_URL: undefined,
    AUTH_MODE: authMode,
    WORKER_SECRET: 'secret',
    BEARER_TOKEN: undefined,
    PORT: 3099,
    BIND: '127.0.0.1',
    APP_URL: 'http://localhost:3099',
    NODE_ENV: 'test',
    REFLECTION_ENABLED: 'false',
    REFLECTION_MIN_TURNS: 3,
    REFLECTION_MAX_PER_HOUR: 6,
    REFLECTION_MAX_TURNS: 3,
  CURATOR_STALE_DAYS: 30,
  CURATOR_ARCHIVE_DAYS: 90,
  CURATOR_MIN_SKILLS: 5,
  CURATOR_INTERVAL_DAYS: 7,
  CURATOR_MAX_TURNS: 4,
  };
}

describe('seedDefaultLlmKey (Brique 25 guard)', () => {
  it('local-auth single-user: seeds entity_llm_keys and wires agents when exactly 1 entity exists', async () => {
    const { db } = await spinUpTestDb();
    // seedMinimal creates 1 user + 1 entity + 1 agent (with llmKeyId already set by updated helper)
    // To test the seeder's wiring path, we need an agent WITHOUT an llmKeyId.
    // Create the entity + agent manually with no llmKeyId.
    const [user] = await db
      .insert(users)
      .values({ email: `seeder-test-${Date.now()}@example.com` })
      .returning();
    if (!user) throw new Error('seed user');

    const [entity] = await db
      .insert(entities)
      .values({ userId: user.id, name: 'E1', slug: `e1-${Date.now()}` })
      .returning();
    if (!entity) throw new Error('seed entity');

    const [agent] = await db
      .insert(agents)
      .values({
        entityId: entity.id,
        name: 'A1',
        slug: `a1-${Date.now()}`,
        personality: 'test',
        llmKeyId: null, // no key yet
      })
      .returning();
    if (!agent) throw new Error('seed agent');

    // Before seeding: 0 keys
    const [beforeCount] = await (db as TestDb)
      .select({ n: count() })
      .from(entityLlmKeys)
      .where(eq(entityLlmKeys.entityId, entity.id));
    expect(beforeCount?.n).toBe(0);

    await seedDefaultLlmKey(db as TestDb, makeEnv('local-auth'));

    // After seeding: 1 key for the entity
    const [afterCount] = await (db as TestDb)
      .select({ n: count() })
      .from(entityLlmKeys)
      .where(eq(entityLlmKeys.entityId, entity.id));
    expect(afterCount?.n).toBe(1);

    // Agent should now have llmKeyId wired
    const [agentRow] = await (db as TestDb)
      .select({ llmKeyId: agents.llmKeyId })
      .from(agents)
      .where(eq(agents.id, agent.id));
    expect(agentRow?.llmKeyId).not.toBeNull();
  });

  it('local-auth multi-user: skips seeding when >1 entities exist', async () => {
    const { db } = await spinUpTestDb();

    // Create 2 users + 2 entities
    const [u1] = await db
      .insert(users)
      .values({ email: `multi-u1-${Date.now()}@example.com` })
      .returning();
    const [u2] = await db
      .insert(users)
      .values({ email: `multi-u2-${Date.now()}@example.com` })
      .returning();
    if (!u1 || !u2) throw new Error('seed users');

    await db.insert(entities).values({ userId: u1.id, name: 'E1', slug: `e1m-${Date.now()}` });
    await db.insert(entities).values({ userId: u2.id, name: 'E2', slug: `e2m-${Date.now()}` });

    await seedDefaultLlmKey(db as TestDb, makeEnv('local-auth'));

    // No keys should have been seeded
    const [afterCount] = await (db as TestDb).select({ n: count() }).from(entityLlmKeys);
    expect(afterCount?.n).toBe(0);
  });

  it('local-trust: seeds correctly for the single entity (unchanged behavior)', async () => {
    const { db } = await spinUpTestDb();

    const [user] = await db
      .insert(users)
      .values({ email: `trust-${Date.now()}@example.com` })
      .returning();
    if (!user) throw new Error('seed user');

    const [entity] = await db
      .insert(entities)
      .values({ userId: user.id, name: 'TrustE', slug: `trust-e-${Date.now()}` })
      .returning();
    if (!entity) throw new Error('seed entity');

    // Agent without llmKeyId
    const [agent] = await db
      .insert(agents)
      .values({
        entityId: entity.id,
        name: 'TA',
        slug: `ta-${Date.now()}`,
        personality: 'test',
        llmKeyId: null,
      })
      .returning();
    if (!agent) throw new Error('seed agent');

    await seedDefaultLlmKey(db as TestDb, makeEnv('local-trust'));

    // Key seeded
    const [keyRow] = await (db as TestDb)
      .select()
      .from(entityLlmKeys)
      .where(eq(entityLlmKeys.entityId, entity.id));
    expect(keyRow).toBeDefined();
    expect(keyRow?.provider).toBe('openai-compatible');
    // Brique 26: the seeder must store ciphertext, not plaintext, and round-trip.
    expect(keyRow?.apiKey.startsWith('enc:v1:')).toBe(true);
    expect(decrypt(keyRow!.apiKey)).toBe('test-key');
    expect(keyRow?.apiKeyLast4).toBe('-key');

    // Agent wired
    const [agentRow] = await (db as TestDb)
      .select({ llmKeyId: agents.llmKeyId })
      .from(agents)
      .where(eq(agents.id, agent.id));
    expect(agentRow?.llmKeyId).toBe(keyRow?.id);
  });

  it('bearer-token mode: always skips regardless of entity count', async () => {
    const { db } = await spinUpTestDb();

    const [user] = await db
      .insert(users)
      .values({ email: `bearer-${Date.now()}@example.com` })
      .returning();
    if (!user) throw new Error('seed user');

    await db.insert(entities).values({ userId: user.id, name: 'BE', slug: `be-${Date.now()}` });

    await seedDefaultLlmKey(db as TestDb, makeEnv('bearer-token'));

    const [afterCount] = await (db as TestDb).select({ n: count() }).from(entityLlmKeys);
    expect(afterCount?.n).toBe(0);
  });

  it('idempotent: does not seed a second key when one already exists', async () => {
    const { db } = await spinUpTestDb();

    const [user] = await db
      .insert(users)
      .values({ email: `idem-${Date.now()}@example.com` })
      .returning();
    if (!user) throw new Error('seed user');

    const [entity] = await db
      .insert(entities)
      .values({ userId: user.id, name: 'IE', slug: `ie-${Date.now()}` })
      .returning();
    if (!entity) throw new Error('seed entity');

    // Call twice
    await seedDefaultLlmKey(db as TestDb, makeEnv('local-trust'));
    await seedDefaultLlmKey(db as TestDb, makeEnv('local-trust'));

    const [afterCount] = await (db as TestDb)
      .select({ n: count() })
      .from(entityLlmKeys)
      .where(eq(entityLlmKeys.entityId, entity.id));
    expect(afterCount?.n).toBe(1);
  });
});
