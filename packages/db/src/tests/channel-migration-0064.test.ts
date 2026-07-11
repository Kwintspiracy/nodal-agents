// channel-migration-0064.test.ts — S2 (multichannel plan).
//
// Applies the ACTUAL migration 0064 SQL to a bare pre-migration schema
// (agents + telegram_allowed_chats only — no channel_bindings /
// channel_allowed_conversations yet), seeded with realistic legacy data, and
// asserts:
//   - channel_bindings gets exactly one row per token-bearing agent, with
//     credentials/bot_identity/cursor built from the legacy telegram_* columns.
//   - channel_allowed_conversations gets a 1:1 copy of every
//     telegram_allowed_chats row, with `kind` inferred from the chat id's sign
//     (Telegram's own group/supergroup convention).
//   - re-running just the back-fill INSERTs (ON CONFLICT DO NOTHING) is a
//     no-op — proves the idempotency the migration comment promises.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';

const here = dirname(fileURLToPath(import.meta.url));
const migrationSql = readFileSync(
  join(here, '../../migrations/0064_channel_bindings_and_allowed_conversations.sql'),
  'utf8',
);

// Split on drizzle's statement-breakpoint marker so the two back-fill INSERTs
// (the last two statements) can be re-run on their own to prove idempotency —
// re-running the CREATE TABLE statements would just throw "already exists",
// which is not what "idempotent" means here (the real migrator only ever
// applies a migration file once, tracked in its own journal table).
const statements = migrationSql
  .split('--> statement-breakpoint')
  .map((s) => s.trim())
  .filter(Boolean);
const ddlStatements = statements.slice(0, -2);
const bindingsBackfillSql = statements[statements.length - 2]!;
const conversationsBackfillSql = statements[statements.length - 1]!;

describe('migration 0064: channel_bindings + channel_allowed_conversations', () => {
  it('creates the tables, back-fills from agents/telegram_allowed_chats, and is idempotent on re-run', async () => {
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
        name text NOT NULL, slug text NOT NULL, personality text NOT NULL,
        telegram_bot_token text,
        telegram_bot_username text,
        telegram_offset bigint,
        last_seen_chat_id_telegram text
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
      CREATE UNIQUE INDEX telegram_allowed_chats_single_owner
        ON telegram_allowed_chats (agent_id) WHERE role = 'owner';
    `);

    const { rows: users } = await pg.query<{ id: string }>(
      `INSERT INTO users (email) VALUES ('channel-migration@example.com') RETURNING id`,
    );
    const { rows: entities } = await pg.query<{ id: string }>(
      `INSERT INTO entities (user_id, name, slug) VALUES ($1, 'Channel Migration Entity', 'channel-migration-entity') RETURNING id`,
      [users[0]!.id],
    );
    const entityId = entities[0]!.id;

    const { rows: agentRows } = await pg.query<{ id: string }>(
      `INSERT INTO agents (entity_id, name, slug, personality, telegram_bot_token, telegram_bot_username, telegram_offset)
       VALUES ($1, 'Bot Agent', 'bot-agent', 'test', 'secret-token-123', 'bot_username', 42) RETURNING id`,
      [entityId],
    );
    const agentId = agentRows[0]!.id;

    // A second agent with NO telegram_bot_token must NOT get a channel_bindings row.
    const { rows: bareAgentRows } = await pg.query<{ id: string }>(
      `INSERT INTO agents (entity_id, name, slug, personality) VALUES ($1, 'Bare Agent', 'bare-agent', 'test') RETURNING id`,
      [entityId],
    );
    const bareAgentId = bareAgentRows[0]!.id;

    await pg.query(
      `INSERT INTO telegram_allowed_chats (entity_id, agent_id, chat_id, role, status, requester_name)
       VALUES
         ($1, $2, '111', 'owner', 'active', 'Owner Person'),
         ($1, $2, '222', 'member', 'active', 'Active Member'),
         ($1, $2, '333', 'member', 'pending', 'Pending Member'),
         ($1, $2, '-9988776655', 'member', 'active', 'Group Chat')`,
      [entityId, agentId],
    );

    for (const stmt of ddlStatements) {
      await pg.exec(stmt);
    }
    await pg.exec(bindingsBackfillSql);
    await pg.exec(conversationsBackfillSql);

    // channel_bindings: exactly one row, for the token-bearing agent.
    const { rows: bindingRows } = await pg.query<{
      agent_id: string;
      channel: string;
      credentials: string;
      bot_identity: string;
      cursor: string;
      enabled: boolean;
    }>(
      `SELECT agent_id, channel, credentials, bot_identity::text AS bot_identity, cursor, enabled FROM channel_bindings`,
    );
    expect(bindingRows).toHaveLength(1);
    const binding = bindingRows[0]!;
    expect(binding.agent_id).toBe(agentId);
    expect(binding.channel).toBe('telegram');
    expect(JSON.parse(binding.credentials)).toEqual({ botToken: 'secret-token-123' });
    expect(JSON.parse(binding.bot_identity)).toEqual({ username: 'bot_username' });
    expect(binding.cursor).toBe('42');
    expect(binding.enabled).toBe(true);

    // Bare agent (no telegram token) never got a binding.
    const { rows: bareBinding } = await pg.query(
      `SELECT * FROM channel_bindings WHERE agent_id = $1`,
      [bareAgentId],
    );
    expect(bareBinding).toHaveLength(0);

    // channel_allowed_conversations: 4 rows, 1:1 from telegram_allowed_chats,
    // with kind inferred from the chat id's sign.
    const { rows: convoRows } = await pg.query<{
      conversation_id: string;
      kind: string;
      role: string;
      status: string;
      requester_name: string;
    }>(
      `SELECT conversation_id, kind, role, status, requester_name FROM channel_allowed_conversations ORDER BY conversation_id`,
    );
    expect(convoRows).toHaveLength(4);
    expect(convoRows).toEqual(
      expect.arrayContaining([
        {
          conversation_id: '111',
          kind: 'private',
          role: 'owner',
          status: 'active',
          requester_name: 'Owner Person',
        },
        {
          conversation_id: '222',
          kind: 'private',
          role: 'member',
          status: 'active',
          requester_name: 'Active Member',
        },
        {
          conversation_id: '333',
          kind: 'private',
          role: 'member',
          status: 'pending',
          requester_name: 'Pending Member',
        },
        {
          conversation_id: '-9988776655',
          kind: 'group',
          role: 'member',
          status: 'active',
          requester_name: 'Group Chat',
        },
      ]),
    );

    // Re-running the back-fill INSERTs on their own (ON CONFLICT DO NOTHING)
    // must not change row counts or throw.
    await expect(pg.exec(bindingsBackfillSql)).resolves.toBeDefined();
    await expect(pg.exec(conversationsBackfillSql)).resolves.toBeDefined();

    const { rows: bindingCount } = await pg.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM channel_bindings`,
    );
    expect(bindingCount[0]!.count).toBe(1);
    const { rows: convoCount } = await pg.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM channel_allowed_conversations`,
    );
    expect(convoCount[0]!.count).toBe(4);

    await pg.close();
  });
});
