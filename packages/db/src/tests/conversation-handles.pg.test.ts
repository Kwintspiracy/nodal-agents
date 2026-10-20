// conversation-handles.pg.test.ts — migration 0152 against a REAL Postgres (#824).
//
// WHY A SEPARATE FILE. `pnpm test` builds its database from the inline SQL in
// `helpers.ts`, never from `migrations/`; a migration missing from
// `meta/_journal.json` is skipped in silence. Only the real migrations show
// that `conversation_handles` exists with its unique key and its form check,
// that two connections racing on one conversation leave one row, and that the
// JIDs already written as names are repaired.
//
// The startup is a TEST, not a beforeAll (a throwing beforeAll marks the tests
// "skipped", and a skipped test is a false green — invariant #4).

import { describe, it, expect, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import postgres from 'postgres';
import { startRealPostgres, type RealPostgres } from '@nodal-agents/test-kit';
import { runMigrations } from '@nodal-agents/db/migrate';
import { createClient } from '../client.ts';
import { conversationHandleFor } from '../queries/conversation-handles.ts';

let pg: RealPostgres | null = null;

afterAll(async () => {
  await pg?.stop();
});

function harness(): RealPostgres {
  if (!pg) expect.fail('REAL_POSTGRES_NOT_STARTED — the startup test failed before this one');
  return pg;
}

async function seedEntity(sql: postgres.Sql, slug: string): Promise<string> {
  const [user] =
    await sql`INSERT INTO users (email) VALUES (${`${slug}@example.com`}) RETURNING id`;
  const [entity] = await sql`
    INSERT INTO entities (user_id, name, slug) VALUES (${user!.id}, 'e', ${slug}) RETURNING id`;
  return entity!.id as string;
}

describe('migration 0152_conversation_handles @cap:parler-par-canal-externe/moteur', () => {
  it('starts a real Postgres and applies the REAL migrations — red if the binary is missing, not skipped', async () => {
    pg = await startRealPostgres();
    await runMigrations(pg.url, { patchVectorAsText: true });
  }, 120_000);

  it('creates the table with its unique key on (entity, channel, conversation) and its form check', async () => {
    const sql = postgres(harness().url, { max: 1 });
    try {
      const cols = await sql`
        SELECT column_name, data_type, is_nullable FROM information_schema.columns
        WHERE table_name = 'conversation_handles' ORDER BY ordinal_position`;
      expect(cols.map((c) => [c.column_name, c.data_type, c.is_nullable])).toEqual([
        ['id', 'text', 'NO'],
        ['entity_id', 'uuid', 'NO'],
        ['channel', 'text', 'NO'],
        ['conversation_id', 'text', 'NO'],
        ['created_at', 'timestamp with time zone', 'NO'],
      ]);
      const [unique] = await sql`
        SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
        WHERE conname = 'conversation_handles_entity_channel_conversation_unique'`;
      expect(unique?.def).toBe('UNIQUE (entity_id, channel, conversation_id)');

      const entityId = await seedEntity(sql, 'handles-key');
      await sql`
        INSERT INTO conversation_handles (id, entity_id, channel, conversation_id)
        VALUES ('conv_aaaaaaaaaa', ${entityId}, 'whatsapp', '33600000000@s.whatsapp.net')`;
      await expect(sql`
        INSERT INTO conversation_handles (id, entity_id, channel, conversation_id)
        VALUES ('conv_bbbbbbbbbb', ${entityId}, 'whatsapp', '33600000000@s.whatsapp.net')`).rejects.toThrow(
        /conversation_handles_entity_channel_conversation_unique/,
      );
      // Un identifiant de canal n'entre pas comme handle.
      await expect(sql`
        INSERT INTO conversation_handles (id, entity_id, channel, conversation_id)
        VALUES ('33600000000@s.whatsapp.net', ${entityId}, 'whatsapp', 'x')`).rejects.toThrow(
        /conversation_handles_id_check/,
      );
    } finally {
      await sql.end();
    }
  });

  it('two connections racing on one conversation leave ONE row, and both read it', async () => {
    const sql = postgres(harness().url, { max: 1 });
    const clients = Array.from({ length: 4 }, () => createClient(harness().url, { max: 1 }));
    try {
      const entityId = await seedEntity(sql, 'handles-race');
      const handles = await Promise.all(
        clients.flatMap((c) =>
          Array.from({ length: 3 }, () =>
            conversationHandleFor(c.db, {
              entityId,
              channel: 'whatsapp',
              conversationId: '33611111111@s.whatsapp.net',
            }),
          ),
        ),
      );
      expect(new Set(handles).size).toBe(1);
      const rows = await sql`SELECT id FROM conversation_handles WHERE entity_id = ${entityId}`;
      expect(rows.map((r) => r.id)).toEqual([handles[0]]);
    } finally {
      await Promise.all(clients.map((c) => c.close()));
      await sql.end();
    }
  });

  it('repairs the WhatsApp names that were a JID, and leaves real names alone', async () => {
    const sql = postgres(harness().url, { max: 1 });
    try {
      const entityId = await seedEntity(sql, 'handles-names');
      const [agent] = await sql`
        INSERT INTO agents (entity_id, name, slug, personality)
        VALUES (${entityId}, 'a', 'a-names', 'p') RETURNING id`;
      const insert = (channel: string, conversationId: string, name: string) => sql`
        INSERT INTO channel_allowed_conversations
          (entity_id, agent_id, channel, conversation_id, requester_name)
        VALUES (${entityId}, ${agent!.id}, ${channel}, ${conversationId}, ${name})`;
      await insert('whatsapp', '33622222222@s.whatsapp.net', '33622222222@s.whatsapp.net');
      await insert('whatsapp', '120363000000@g.us', '33633333333@s.whatsapp.net');
      await insert('whatsapp', '33644444444@s.whatsapp.net', 'Marie');
      await insert('discord', '1188', 'Paul');

      // La réparation est la seconde instruction de la migration, rejouée sur ces lignes.
      const migration = readFileSync(
        join(__dirname, '..', '..', 'migrations', '0152_conversation_handles.sql'),
        'utf8',
      );
      await sql.unsafe(migration.split('--> statement-breakpoint')[1]!);

      const rows = await sql`
        SELECT channel, conversation_id, requester_name FROM channel_allowed_conversations
        WHERE entity_id = ${entityId} ORDER BY channel, conversation_id`;
      expect(rows.map((r) => [r.channel, r.conversation_id, r.requester_name])).toEqual([
        ['discord', '1188', 'Paul'],
        ['whatsapp', '120363000000@g.us', 'Someone'],
        ['whatsapp', '33622222222@s.whatsapp.net', 'Someone'],
        ['whatsapp', '33644444444@s.whatsapp.net', 'Marie'],
      ]);
    } finally {
      await sql.end();
    }
  });
});
