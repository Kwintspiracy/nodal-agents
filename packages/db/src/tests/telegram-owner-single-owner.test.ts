// telegram-owner-single-owner.test.ts — F1 (audit #2 remediation follow-up).
//
// telegram_allowed_chats had UNIQUE(agent_id, chat_id) but nothing prevented
// two role='owner' rows for the same agent: a concurrent first-contact claim
// (two chats DMing a fresh bot at once) could each pass the "no owner yet"
// check before either insert commits. Every owner-resolution query
// (resolveOwnerChatId, resolveApprovalDeliveryTarget) does LIMIT 1 assuming
// uniqueness, so a co-owner would silently lose visibility into approval
// cards. Migration 0060 adds a partial UNIQUE INDEX (agent_id) WHERE
// role='owner', preceded by a dedup pass (migration 0007/0054 pattern) so an
// upgraded install that already carries duplicate owners doesn't brick `up`.
//
// Two things are tested here:
//   1. The dedup pass itself, by literally applying migration 0060's SQL to a
//      pglite DB seeded with duplicate owners (pre-fix schema — no
//      single-owner index yet, so the seed can actually violate it).
//   2. The resulting constraint, via the normal (post-fix) schema helper.

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { spinUpTestDb, seedMinimal } from './helpers.ts';
import type { TestDb } from './helpers.ts';
import * as schema from '../schema/index.ts';

const here = dirname(fileURLToPath(import.meta.url));
const migrationSql = readFileSync(
  join(here, '../../migrations/0060_telegram_allowed_chats_single_owner.sql'),
  'utf8',
);

describe('migration 0060: telegram_allowed_chats single-owner dedup', () => {
  it('demotes every owner but the OLDEST to member, then blocks a new duplicate owner', async () => {
    // Bare pre-fix schema: no single-owner index, so duplicate owners can
    // actually be seeded (the whole point of the dedup pass being tested).
    const pg = new PGlite();
    await pg.exec(`
      CREATE TABLE users (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        email text NOT NULL UNIQUE
      );
      CREATE TABLE entities (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name text NOT NULL,
        slug text NOT NULL UNIQUE
      );
      CREATE TABLE agents (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        entity_id uuid REFERENCES entities(id) ON DELETE CASCADE,
        name text NOT NULL,
        slug text NOT NULL,
        personality text NOT NULL
      );
      CREATE TABLE telegram_allowed_chats (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        entity_id uuid REFERENCES entities(id) ON DELETE CASCADE,
        agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
        chat_id text NOT NULL,
        role text NOT NULL DEFAULT 'member',
        status text NOT NULL DEFAULT 'pending',
        requester_name text,
        created_at timestamptz DEFAULT now(),
        updated_at timestamptz DEFAULT now(),
        CONSTRAINT telegram_allowed_chats_agent_chat_unique UNIQUE (agent_id, chat_id),
        CONSTRAINT telegram_allowed_chats_role_check CHECK (role IN ('owner','member')),
        CONSTRAINT telegram_allowed_chats_status_check CHECK (status IN ('active','pending'))
      );
    `);

    const { rows: users } = await pg.query<{ id: string }>(
      `INSERT INTO users (email) VALUES ('owner-dedup@example.com') RETURNING id`,
    );
    const userId = users[0]!.id;
    const { rows: entities } = await pg.query<{ id: string }>(
      `INSERT INTO entities (user_id, name, slug) VALUES ($1, 'Dedup Entity', 'owner-dedup-entity') RETURNING id`,
      [userId],
    );
    const entityId = entities[0]!.id;
    const { rows: agentRows } = await pg.query<{ id: string }>(
      `INSERT INTO agents (entity_id, name, slug, personality) VALUES ($1, 'Agent A', 'agent-a', 'test'), ($1, 'Agent B', 'agent-b', 'test') RETURNING id`,
      [entityId],
    );
    const [agentAId, agentBId] = agentRows.map((r) => r.id) as [string, string];

    // Agent A: two co-owners, seeded out of insertion order — row2 (newer
    // created_at) is inserted FIRST, row1 (older) inserted SECOND, so the
    // survivor must be picked by created_at, not by insertion/id order.
    const { rows: row2 } = await pg.query<{ id: string }>(
      `INSERT INTO telegram_allowed_chats (entity_id, agent_id, chat_id, role, status, created_at)
       VALUES ($1, $2, 'chat-newer', 'owner', 'active', now()) RETURNING id`,
      [entityId, agentAId],
    );
    const { rows: row1 } = await pg.query<{ id: string }>(
      `INSERT INTO telegram_allowed_chats (entity_id, agent_id, chat_id, role, status, created_at)
       VALUES ($1, $2, 'chat-older', 'owner', 'active', now() - interval '1 hour') RETURNING id`,
      [entityId, agentAId],
    );
    const olderId = row1[0]!.id;
    const newerId = row2[0]!.id;

    // Agent B: a single, untouched owner — proves the dedup is scoped per
    // agent and a different agent's owner is left alone.
    const { rows: bOwner } = await pg.query<{ id: string }>(
      `INSERT INTO telegram_allowed_chats (entity_id, agent_id, chat_id, role, status)
       VALUES ($1, $2, 'chat-b', 'owner', 'active') RETURNING id`,
      [entityId, agentBId],
    );
    const agentBOwnerRowId = bOwner[0]!.id;

    // Apply the migration.
    await pg.exec(migrationSql);

    // Agent A: exactly one owner (the oldest), the other demoted to member —
    // its status ('active') is preserved, only role changed.
    const { rows: aRows } = await pg.query<{ id: string; role: string; status: string }>(
      `SELECT id, role, status FROM telegram_allowed_chats WHERE agent_id = $1 ORDER BY created_at ASC`,
      [agentAId],
    );
    expect(aRows).toHaveLength(2);
    expect(aRows[0]).toMatchObject({ id: olderId, role: 'owner', status: 'active' });
    expect(aRows[1]).toMatchObject({ id: newerId, role: 'member', status: 'active' });

    // Agent B: untouched, still the sole owner.
    const { rows: bRows } = await pg.query<{ id: string; role: string }>(
      `SELECT id, role FROM telegram_allowed_chats WHERE agent_id = $1`,
      [agentBId],
    );
    expect(bRows).toEqual([{ id: agentBOwnerRowId, role: 'owner' }]);

    // The unique index now rejects a second owner for agent A...
    await expect(
      pg.query(
        `INSERT INTO telegram_allowed_chats (entity_id, agent_id, chat_id, role, status) VALUES ($1, $2, 'chat-third', 'owner', 'active')`,
        [entityId, agentAId],
      ),
    ).rejects.toThrow();

    // ...but a second owner for a DIFFERENT agent is unaffected (the index is
    // partitioned by agent_id).
    const { rows: cAgent } = await pg.query<{ id: string }>(
      `INSERT INTO agents (entity_id, name, slug, personality) VALUES ($1, 'Agent C', 'agent-c', 'test') RETURNING id`,
      [entityId],
    );
    await expect(
      pg.query(
        `INSERT INTO telegram_allowed_chats (entity_id, agent_id, chat_id, role, status) VALUES ($1, $2, 'chat-c', 'owner', 'active')`,
        [entityId, cAgent[0]!.id],
      ),
    ).resolves.toBeDefined();

    await pg.close();
  });

  // Re-applying the migration on an already-clean DB (no duplicate owners) is
  // a no-op — every DELETE/UPDATE in the audit#2 dedup pattern must be
  // idempotent so a re-run migration folder never throws.
  it('is a no-op when there are no duplicate owners', async () => {
    const pg = new PGlite();
    await pg.exec(`
      CREATE TABLE users (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), email text NOT NULL UNIQUE);
      CREATE TABLE entities (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name text NOT NULL, slug text NOT NULL UNIQUE
      );
      CREATE TABLE agents (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        entity_id uuid REFERENCES entities(id) ON DELETE CASCADE,
        name text NOT NULL, slug text NOT NULL, personality text NOT NULL
      );
      CREATE TABLE telegram_allowed_chats (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        entity_id uuid REFERENCES entities(id) ON DELETE CASCADE,
        agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
        chat_id text NOT NULL,
        role text NOT NULL DEFAULT 'member',
        status text NOT NULL DEFAULT 'pending',
        requester_name text,
        created_at timestamptz DEFAULT now(),
        updated_at timestamptz DEFAULT now(),
        CONSTRAINT telegram_allowed_chats_agent_chat_unique UNIQUE (agent_id, chat_id),
        CONSTRAINT telegram_allowed_chats_role_check CHECK (role IN ('owner','member')),
        CONSTRAINT telegram_allowed_chats_status_check CHECK (status IN ('active','pending'))
      );
    `);
    const { rows: users } = await pg.query<{ id: string }>(
      `INSERT INTO users (email) VALUES ('owner-noop@example.com') RETURNING id`,
    );
    const { rows: entities } = await pg.query<{ id: string }>(
      `INSERT INTO entities (user_id, name, slug) VALUES ($1, 'Noop Entity', 'owner-noop-entity') RETURNING id`,
      [users[0]!.id],
    );
    const { rows: agentRows } = await pg.query<{ id: string }>(
      `INSERT INTO agents (entity_id, name, slug, personality) VALUES ($1, 'Agent Solo', 'agent-solo', 'test') RETURNING id`,
      [entities[0]!.id],
    );
    await pg.query(
      `INSERT INTO telegram_allowed_chats (entity_id, agent_id, chat_id, role, status) VALUES ($1, $2, 'chat-solo', 'owner', 'active')`,
      [entities[0]!.id, agentRows[0]!.id],
    );

    await expect(pg.exec(migrationSql)).resolves.toBeDefined();

    const { rows } = await pg.query<{ role: string }>(
      `SELECT role FROM telegram_allowed_chats WHERE agent_id = $1`,
      [agentRows[0]!.id],
    );
    expect(rows).toEqual([{ role: 'owner' }]);

    await pg.close();
  });
});

describe('telegram_allowed_chats: single-owner constraint (post-migration schema)', () => {
  let db: TestDb;
  let seed: Awaited<ReturnType<typeof seedMinimal>>;

  beforeAll(async () => {
    const result = await spinUpTestDb();
    db = result.db;
    seed = await seedMinimal(db);
  });

  it('rejects a second owner row for the same agent', async () => {
    await db.insert(schema.telegramAllowedChats).values({
      entityId: seed.entityId,
      agentId: seed.agentId,
      chatId: 'schema-owner-1',
      role: 'owner',
      status: 'active',
    });
    await expect(
      db.insert(schema.telegramAllowedChats).values({
        entityId: seed.entityId,
        agentId: seed.agentId,
        chatId: 'schema-owner-2',
        role: 'owner',
        status: 'active',
      }),
    ).rejects.toThrow();
  });

  it('allows an owner row for a different agent', async () => {
    const [otherAgent] = await db
      .insert(schema.agents)
      .values({
        entityId: seed.entityId,
        name: 'Other Owner Agent',
        slug: `other-owner-agent-${Date.now()}`,
        personality: 'test',
      })
      .returning();
    await expect(
      db.insert(schema.telegramAllowedChats).values({
        entityId: seed.entityId,
        agentId: otherAgent!.id,
        chatId: 'schema-owner-other-agent',
        role: 'owner',
        status: 'active',
      }),
    ).resolves.toBeDefined();
  });

  it('still allows multiple member rows for the same agent', async () => {
    await db.insert(schema.telegramAllowedChats).values({
      entityId: seed.entityId,
      agentId: seed.agentId,
      chatId: 'schema-member-1',
      role: 'member',
      status: 'active',
    });
    await expect(
      db.insert(schema.telegramAllowedChats).values({
        entityId: seed.entityId,
        agentId: seed.agentId,
        chatId: 'schema-member-2',
        role: 'member',
        status: 'active',
      }),
    ).resolves.toBeDefined();
  });
});
