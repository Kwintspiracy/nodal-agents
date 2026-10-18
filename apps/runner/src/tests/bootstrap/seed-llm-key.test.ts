// seed-llm-key.test.ts — Brique 25 seeder guard logic
//
// Tests:
//   1. local-auth single-user → seeds correctly (the case Quentin hit)
//   2. local-auth multi-user  → skips (>1 member workspaces)
//   3. local-trust            → unchanged behavior (seeds for the single workspace)
//   4. a member-less entity (a team copy driven by a tool) changes nothing
//
// Every workspace a person uses has an entity_members row (seedLocalUser, the
// sign-up hook, createWorkspaceAction): the tests give theirs one, like a
// real install.

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { spinUpTestDb } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import { eq, count } from '@nodal-agents/db';
import { entityLlmKeys, agents, entities, entityMembers, users } from '@nodal-agents/db';
import {
  _setMasterKeyForTests,
  _resetMasterKeyCacheForTests,
  decrypt,
  encrypt,
} from '@nodal-agents/secrets';
import {
  seedDefaultLlmKey,
  _resetSeedLlmKeyWarningsForTests,
} from '../../bootstrap/seed-llm-key.ts';
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
}

/** A workspace a person uses: the entity and its owner's membership. */
async function memberWorkspace(db: TestDb, userId: string, name: string): Promise<string> {
  const [entity] = await db
    .insert(entities)
    .values({ userId, name, slug: `${name.toLowerCase()}-${randomBytes(4).toString('hex')}` })
    .returning();
  if (!entity) throw new Error('seed entity');
  await db.insert(entityMembers).values({ entityId: entity.id, userId, role: 'owner' });
  return entity.id;
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
    await db.insert(entityMembers).values({ entityId: entity.id, userId: user.id });

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

  it('local-auth multi-user: skips seeding when >1 member workspaces exist', async () => {
    const { db } = await spinUpTestDb();

    // Create 2 users, each with their own workspace
    const [u1] = await db
      .insert(users)
      .values({ email: `multi-u1-${Date.now()}@example.com` })
      .returning();
    const [u2] = await db
      .insert(users)
      .values({ email: `multi-u2-${Date.now()}@example.com` })
      .returning();
    if (!u1 || !u2) throw new Error('seed users');

    await memberWorkspace(db as TestDb, u1.id, 'E1');
    await memberWorkspace(db as TestDb, u2.id, 'E2');

    await seedDefaultLlmKey(db as TestDb, makeEnv('local-auth'));

    // No keys should have been seeded
    const [afterCount] = await (db as TestDb).select({ n: count() }).from(entityLlmKeys);
    expect(afterCount?.n).toBe(0);
  });

  it('one person with two workspaces: skips, the env key belongs to neither in particular', async () => {
    const { db } = await spinUpTestDb();
    const [user] = await db
      .insert(users)
      .values({ email: `two-ws-${Date.now()}@example.com` })
      .returning();
    if (!user) throw new Error('seed user');
    await memberWorkspace(db as TestDb, user.id, 'Home');
    await memberWorkspace(db as TestDb, user.id, 'Second');

    await seedDefaultLlmKey(db as TestDb, makeEnv('local-trust'));

    const [afterCount] = await (db as TestDb).select({ n: count() }).from(entityLlmKeys);
    expect(afterCount?.n).toBe(0);
  });

  it.each(['older', 'newer'] as const)(
    'a member-less entity (%s than the workspace) does not switch the seed off, and gets nothing',
    async (age) => {
      // The case the bench space created: a copy of the team, nobody's
      // workspace. Counting every entity made the owner's workspace lose its
      // seed; taking the "first" one could have seeded the copy.
      const { db } = await spinUpTestDb();
      const [user] = await db
        .insert(users)
        .values({ email: `copy-${age}-${Date.now()}@example.com` })
        .returning();
      if (!user) throw new Error('seed user');

      const insertCopy = async () => {
        const [copy] = await db
          .insert(entities)
          .values({
            userId: user.id,
            name: 'Copy',
            slug: `copy-${randomBytes(4).toString('hex')}`,
            createdAt: age === 'older' ? new Date('2020-01-01') : new Date('2100-01-01'),
          })
          .returning();
        if (!copy) throw new Error('seed copy');
        await db.insert(agents).values({
          entityId: copy.id,
          name: 'CopyAgent',
          slug: `copy-agent-${Date.now()}`,
          personality: 'test',
          llmKeyId: null,
        });
        return copy.id;
      };
      const copyId = await insertCopy();
      const homeId = await memberWorkspace(db as TestDb, user.id, 'Home');
      const [agent] = await db
        .insert(agents)
        .values({
          entityId: homeId,
          name: 'HomeAgent',
          slug: `home-agent-${Date.now()}`,
          personality: 'test',
          llmKeyId: null,
        })
        .returning();
      if (!agent) throw new Error('seed agent');

      await seedDefaultLlmKey(db as TestDb, makeEnv('local-trust'));

      const keys = await (db as TestDb)
        .select({ id: entityLlmKeys.id, entityId: entityLlmKeys.entityId })
        .from(entityLlmKeys);
      expect(keys.map((k) => k.entityId)).toEqual([homeId]);
      const [agentRow] = await (db as TestDb)
        .select({ llmKeyId: agents.llmKeyId })
        .from(agents)
        .where(eq(agents.id, agent.id));
      expect(agentRow?.llmKeyId).toBe(keys[0]!.id);
      const copyAgents = await (db as TestDb)
        .select({ llmKeyId: agents.llmKeyId })
        .from(agents)
        .where(eq(agents.entityId, copyId));
      expect(copyAgents).toEqual([{ llmKeyId: null }]);
    },
  );

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
    await db.insert(entityMembers).values({ entityId: entity.id, userId: user.id });

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

  // F-22 regression (reviewer-caught): an agent left with llmKeyId=NULL when
  // the entity ALREADY has a default key must NOT be silently re-wired. That
  // NULL can come from a user's deliberate key rotation/detachment
  // (deleteLlmKeyAction relies on ON DELETE SET NULL to preserve the agent
  // rather than delete it) and is indistinguishable, from this function's
  // point of view, from a stranded post-crash state. Re-wiring it anyway
  // would silently override the user's choice onto a provider they never
  // picked for that agent — a silent smart fallback (invariant #4).
  it('does NOT re-wire a voluntarily-detached agent when the entity already has a default key', async () => {
    const { db } = await spinUpTestDb();

    const [user] = await db
      .insert(users)
      .values({ email: `detach-${Date.now()}@example.com` })
      .returning();
    if (!user) throw new Error('seed user');

    const [entity] = await db
      .insert(entities)
      .values({ userId: user.id, name: 'DE', slug: `de-${Date.now()}` })
      .returning();
    if (!entity) throw new Error('seed entity');
    await db.insert(entityMembers).values({ entityId: entity.id, userId: user.id });

    // The entity already went through a normal seed boot: the default env
    // key exists (as `seedDefaultLlmKey` itself would have created it).
    const [defaultKey] = await db
      .insert(entityLlmKeys)
      .values({
        entityId: entity.id,
        provider: 'openai-compatible',
        apiKey: encrypt('default-key'),
        apiKeyLast4: '-key',
        nickname: 'Default (env)',
        isActive: true,
      })
      .returning();
    if (!defaultKey) throw new Error('seed default key');

    // A second key the user added, then deleted/rotated — ON DELETE SET NULL
    // is what actually produces an agent's llmKeyId=NULL in that case; we
    // model the resulting end state directly rather than exercising the
    // delete action here.
    const [agent] = await db
      .insert(agents)
      .values({
        entityId: entity.id,
        name: 'DetachedAgent',
        slug: `detached-agent-${Date.now()}`,
        personality: 'test',
        llmKeyId: null, // voluntarily detached, not a crash artifact
      })
      .returning();
    if (!agent) throw new Error('seed agent');

    await seedDefaultLlmKey(db as TestDb, makeEnv('local-trust'));

    // No second key should have been inserted — the entity is already seeded.
    const [afterCount] = await (db as TestDb)
      .select({ n: count() })
      .from(entityLlmKeys)
      .where(eq(entityLlmKeys.entityId, entity.id));
    expect(afterCount?.n).toBe(1);

    // The voluntarily-detached agent must stay NULL, not be silently rewired.
    const [agentRow] = await (db as TestDb)
      .select({ llmKeyId: agents.llmKeyId })
      .from(agents)
      .where(eq(agents.id, agent.id));
    expect(agentRow?.llmKeyId).toBeNull();
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
    await db.insert(entityMembers).values({ entityId: entity.id, userId: user.id });

    // Call twice
    await seedDefaultLlmKey(db as TestDb, makeEnv('local-trust'));
    await seedDefaultLlmKey(db as TestDb, makeEnv('local-trust'));

    const [afterCount] = await (db as TestDb)
      .select({ n: count() })
      .from(entityLlmKeys)
      .where(eq(entityLlmKeys.entityId, entity.id));
    expect(afterCount?.n).toBe(1);
  });

  describe('a skipped seed is said, once', () => {
    beforeEach(() => _resetSeedLlmKeyWarningsForTests());

    async function warningsOf(run: () => Promise<void>): Promise<string[]> {
      const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        await run();
        return spy.mock.calls.map((c) => String(c[0]));
      } finally {
        spy.mockRestore();
      }
    }

    it('a lone entity WITHOUT a member: no key, and the cause and the remedy are logged once', async () => {
      // Before the member rule, one entity was enough to seed. An install whose
      // only entity has no entity_members row would now lose its seed in silence.
      const { db } = await spinUpTestDb();
      const [user] = await db
        .insert(users)
        .values({ email: `lone-${Date.now()}@example.com` })
        .returning();
      await db
        .insert(entities)
        .values({ userId: user!.id, name: 'Lone', slug: `lone-${Date.now()}` });

      const first = await warningsOf(() => seedDefaultLlmKey(db as TestDb, makeEnv('local-auth')));
      expect(first).toHaveLength(1);
      expect(first[0]).toMatch(
        /^\[runner\] seed_llm_key_skipped: 1 workspace\(s\) exist but none has a member/,
      );
      expect(first[0]).toContain('seedLocalUser restores');
      expect(first[0]).toContain('Settings > LLM keys');
      const [keys] = await (db as TestDb).select({ n: count() }).from(entityLlmKeys);
      expect(keys?.n).toBe(0);

      // The cron retries every tick: said once per process, not every two minutes.
      const again = await warningsOf(() => seedDefaultLlmKey(db as TestDb, makeEnv('local-auth')));
      expect(again).toEqual([]);
    });

    it('a fresh install with no entity at all stays silent (first boot before sign-up)', async () => {
      const { db } = await spinUpTestDb();
      expect(
        await warningsOf(() => seedDefaultLlmKey(db as TestDb, makeEnv('local-auth'))),
      ).toEqual([]);
    });

    it('several member workspaces: said only when one of them has no key, naming it', async () => {
      const { db } = await spinUpTestDb();
      const [user] = await db
        .insert(users)
        .values({ email: `several-${Date.now()}@example.com` })
        .returning();
      const keyed = await memberWorkspace(db as TestDb, user!.id, 'Keyed');
      await memberWorkspace(db as TestDb, user!.id, 'Keyless');
      await db.insert(entityLlmKeys).values({ entityId: keyed, provider: 'openai-compatible' });

      const w = await warningsOf(() => seedDefaultLlmKey(db as TestDb, makeEnv('local-auth')));
      expect(w).toHaveLength(1);
      expect(w[0]).toContain('2 workspaces have a member');
      expect(w[0]).toContain('Keyless has no key');
      expect(w[0]).not.toContain('Keyed,');
    });
  });
});
