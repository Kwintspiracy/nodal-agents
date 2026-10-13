// job-chat-channel-migration.pg.test.ts — migration 0143 against a REAL Postgres.
//
// @cap:parler-par-canal-externe/moteur
//
// WHAT THIS PROVES (#649, review of #657 pass 3):
//   - the backfill applies the writers' rule to rows written before the
//     column: a chat that came from a transport carries it; a routine's
//     declared notify channel carries it; a routine on auto or a "Send via
//     Telegram" task carries Telegram ONLY when its chat is the agent's
//     Telegram owner chat; an explicit id nothing ties to a platform stays
//     NULL — never guessed;
//   - the inbox relaunch trigger copies the chat WITH its channel.
//
// The backfill is proven by REPLAYING the file 0143 (idempotent) on rows
// written without the column's value, after migrating to the end.

import { describe, it, expect, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { startRealPostgres, type RealPostgres } from '@nodal-agents/test-kit';
import { createClient, sql } from '@nodal-agents/db';
import { runMigrations } from '@nodal-agents/db/migrate';

let pg: RealPostgres | null = null;

afterAll(async () => {
  await pg?.stop();
});

function harness(): RealPostgres {
  if (!pg) expect.fail('REAL_POSTGRES_NOT_STARTED — the startup test failed before this one');
  return pg;
}

type Db = ReturnType<typeof createClient>['db'];

async function rows<T>(db: Db, q: ReturnType<typeof sql>): Promise<T[]> {
  return (await db.execute(q)) as unknown as T[];
}

async function seed(db: Db): Promise<{ entityId: string; agentId: string }> {
  const slug = `chat-chan-${Date.now()}`;
  const u = await rows<{ id: string }>(
    db,
    sql`INSERT INTO users (email) VALUES (${`${slug}@example.com`}) RETURNING id`,
  );
  const e = await rows<{ id: string }>(
    db,
    sql`INSERT INTO entities (user_id, name, slug) VALUES (${u[0]!.id}, ${slug}, ${slug}) RETURNING id`,
  );
  const a = await rows<{ id: string }>(
    db,
    sql`INSERT INTO agents (entity_id, name, slug, personality)
        VALUES (${e[0]!.id}, ${slug}, ${slug}, 'p') RETURNING id`,
  );
  return { entityId: e[0]!.id, agentId: a[0]!.id };
}

const migration = fileURLToPath(
  new URL('../../migrations/0143_job_chat_channel.sql', import.meta.url),
);

describe('migration 0143_job_chat_channel @cap:parler-par-canal-externe/moteur', () => {
  it('starts a real Postgres and applies the REAL migrations — red if the binary is missing, not skipped', async () => {
    pg = await startRealPostgres();
    await runMigrations(pg.url, { patchVectorAsText: true });
  }, 120_000);

  it('0142 then 0143 both ran: the journal orders them, and the migrator skips none', async () => {
    // drizzle applies an entry only if its `when` is later than the last one
    // applied: 0143 merged after 0142 must carry the later `when`, or a base
    // that already ran 0142 never gets `chat_channel`.
    const { db, close } = createClient(harness().url, { max: 1 });
    try {
      const cols = await rows<{ column_name: string }>(
        db,
        sql`SELECT column_name FROM information_schema.columns
            WHERE table_name = 'agent_jobs'
              AND column_name IN ('system_prompt_version', 'chat_channel')
            ORDER BY column_name`,
      );
      expect(cols.map((c) => c.column_name)).toEqual(['chat_channel', 'system_prompt_version']);
    } finally {
      await close();
    }
    const journal = JSON.parse(
      readFileSync(
        fileURLToPath(new URL('../../migrations/meta/_journal.json', import.meta.url)),
        'utf8',
      ),
    ) as { entries: Array<{ tag: string; when: number }> };
    const when = (tag: string) => journal.entries.find((e) => e.tag === tag)?.when ?? 0;
    expect(when('0143_job_chat_channel')).toBeGreaterThan(when('0142_system_prompt_version'));
  });

  it('the backfill gives a chat the channel it was resolved on, and NULL when nothing says it', async () => {
    const { db, close } = createClient(harness().url, { max: 1 });
    try {
      const { entityId, agentId } = await seed(db);
      await db.execute(sql`INSERT INTO telegram_allowed_chats (entity_id, agent_id, chat_id, role, status)
        VALUES (${entityId}, ${agentId}, 'tg-owner', 'owner', 'active')`);
      const job = async (channel: string, chatId: string, triggerContext: unknown) => {
        const r = await rows<{ id: string }>(
          db,
          sql`INSERT INTO agent_jobs (entity_id, agent_id, channel, task, chat_id, trigger_context)
              VALUES (${entityId}, ${agentId}, ${channel}, 't', ${chatId},
                      ${triggerContext === null ? null : JSON.stringify(triggerContext)}::jsonb)
              RETURNING id`,
        );
        return r[0]!.id;
      };
      const cases = {
        fromTelegram: await job('telegram', 'tg-123', null),
        fromDiscord: await job('discord', 'dc-1', null),
        cronDeclared: await job('cron', 'team-42', { type: 'cron', notifyChannel: 'slack' }),
        cronAutoOwner: await job('cron', 'tg-owner', { type: 'cron', notifyChannel: null }),
        cronAutoExplicit: await job('cron', 'team-group-999', {
          type: 'cron',
          notifyChannel: null,
        }),
        dashboardOwner: await job('dashboard', 'tg-owner', null),
        apiChat: await job('api', 'tg-owner', null),
        delegate: await job('internal', 'tg-owner', null),
      };
      await db.execute(sql.raw(readFileSync(migration, 'utf8')));
      const got: Record<string, string | null> = {};
      for (const [name, id] of Object.entries(cases)) {
        const r = await rows<{ c: string | null }>(
          db,
          sql`SELECT chat_channel AS c FROM agent_jobs WHERE id = ${id}`,
        );
        got[name] = r[0]!.c;
      }
      expect(got).toEqual({
        fromTelegram: 'telegram',
        fromDiscord: 'discord',
        cronDeclared: 'slack',
        cronAutoOwner: 'telegram',
        cronAutoExplicit: null,
        dashboardOwner: 'telegram',
        apiChat: null,
        delegate: null,
      });
    } finally {
      await close();
    }
  });

  it('the inbox relaunch copies the head chat with its channel', async () => {
    const { db, close } = createClient(harness().url, { max: 1 });
    try {
      const { entityId, agentId } = await seed(db);
      const conv = await rows<{ id: string }>(
        db,
        sql`INSERT INTO conversations (entity_id, agent_id, channel, chat_id)
            VALUES (${entityId}, ${agentId}, 'telegram', 'tg-relaunch') RETURNING id`,
      );
      const head = await rows<{ id: string }>(
        db,
        sql`INSERT INTO agent_jobs (entity_id, agent_id, channel, task, chat_id, chat_channel,
                                    conversation_id, status, inbox)
            VALUES (${entityId}, ${agentId}, 'telegram', 't', 'tg-relaunch', 'telegram',
                    ${conv[0]!.id}, 'processing',
                    '[{"task":"next","content":"next"}]'::jsonb)
            RETURNING id`,
      );
      await db.execute(sql`UPDATE agent_jobs SET status = 'completed' WHERE id = ${head[0]!.id}`);
      const relaunched = await rows<{ chatId: string; chatChannel: string | null }>(
        db,
        sql`SELECT chat_id AS "chatId", chat_channel AS "chatChannel" FROM agent_jobs
            WHERE relaunched_from_job_id = ${head[0]!.id}`,
      );
      expect(relaunched).toEqual([{ chatId: 'tg-relaunch', chatChannel: 'telegram' }]);
    } finally {
      await close();
    }
  });
});
