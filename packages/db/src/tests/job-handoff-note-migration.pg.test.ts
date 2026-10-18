// job-handoff-note-migration.pg.test.ts — migration 0150 against a REAL Postgres.
//
// WHAT THIS PROVES (handoff.ts, @nodal-agents/shared):
//   - `original_task`, never written by any code, is gone; `handoff_note` is
//     there, and the journal orders 0150 after 0149;
//   - the backfill gives a chat hand-off made before the column its front's
//     text as its note (the chat replays it as the front's own call), and
//     touches no other job;
//   - the inbox relaunch carries the entry's words as the new head's task and
//     the relaying model's note in `handoff_note`, never merged, and leaves
//     its messages for the loop to open (`openingMessages`).
//
// The backfill is proven by REPLAYING the file 0150 (idempotent) on rows
// written without a note, after migrating to the end.

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
  const slug = `handoff-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
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
  new URL('../../migrations/0150_job_handoff_note.sql', import.meta.url),
);

describe('migration 0150_job_handoff_note @cap:parler-a-un-agent/moteur', () => {
  it('starts a real Postgres and applies the REAL migrations — red if the binary is missing, not skipped', async () => {
    pg = await startRealPostgres();
    await runMigrations(pg.url, { patchVectorAsText: true });
  }, 120_000);

  it('original_task is gone, handoff_note is there, and 0150 is journaled after 0149', async () => {
    const { db, close } = createClient(harness().url, { max: 1 });
    try {
      const cols = await rows<{ column_name: string }>(
        db,
        sql`SELECT column_name FROM information_schema.columns
            WHERE table_name = 'agent_jobs'
              AND column_name IN ('original_task', 'handoff_note')`,
      );
      expect(cols.map((c) => c.column_name)).toEqual(['handoff_note']);
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
    expect(when('0150_job_handoff_note')).toBeGreaterThan(when('0149_tool_call_reads'));
  });

  it('the backfill gives a past chat hand-off its front’s text as its note, and no other job a note', async () => {
    const { db, close } = createClient(harness().url, { max: 1 });
    try {
      const { entityId, agentId } = await seed(db);
      const conv = await rows<{ id: string }>(
        db,
        sql`INSERT INTO conversations (entity_id, agent_id, channel)
            VALUES (${entityId}, ${agentId}, 'dashboard') RETURNING id`,
      );
      const job = async (channel: string, task: string) =>
        (
          await rows<{ id: string }>(
            db,
            sql`INSERT INTO agent_jobs (entity_id, agent_id, channel, task, conversation_id)
                VALUES (${entityId}, ${agentId}, ${channel}, ${task}, ${conv[0]!.id})
                RETURNING id`,
          )
        )[0]!.id;
      const handedOn = await job('dashboard', 'Corrige la feuille et vérifie le rendu.');
      const fromTelegram = await job('telegram', 'Fais-moi un portrait');
      await db.execute(sql`INSERT INTO chat_messages (entity_id, agent_id, conversation_id, role, content, job_id)
        VALUES (${entityId}, ${agentId}, ${conv[0]!.id}, 'assistant', 'Je corrige.', ${handedOn})`);

      await db.execute(sql.raw(readFileSync(migration, 'utf8')));

      const got = await rows<{ id: string; task: string; note: string | null }>(
        db,
        sql`SELECT id, task, handoff_note AS note FROM agent_jobs
            WHERE id IN (${handedOn}, ${fromTelegram}) ORDER BY task`,
      );
      expect(got.map((r) => [r.task, r.note])).toEqual([
        ['Corrige la feuille et vérifie le rendu.', 'Corrige la feuille et vérifie le rendu.'],
        ['Fais-moi un portrait', null],
      ]);
    } finally {
      await close();
    }
  });

  it("the inbox relaunch: the entry's words as the task, the relaying model's note apart, messages left to the loop", async () => {
    const { db, close } = createClient(harness().url, { max: 1 });
    try {
      const { entityId, agentId } = await seed(db);
      const conv = await rows<{ id: string }>(
        db,
        sql`INSERT INTO conversations (entity_id, agent_id, channel, chat_id)
            VALUES (${entityId}, ${agentId}, 'telegram', 'tg-handoff') RETURNING id`,
      );
      const entry = {
        id: 'e1',
        task: 'Un seul trait par chiffre.',
        content: 'Un seul trait par chiffre.',
        receivedAt: '2026-10-18T03:23:32.000Z',
        note: 'Elle corrige le tracé de la feuille.',
      };
      const head = await rows<{ id: string }>(
        db,
        sql`INSERT INTO agent_jobs (entity_id, agent_id, channel, task, chat_id, chat_channel,
                                    conversation_id, status, inbox)
            VALUES (${entityId}, ${agentId}, 'telegram', 't', 'tg-handoff', 'telegram',
                    ${conv[0]!.id}, 'processing', ${JSON.stringify([entry])}::jsonb)
            RETURNING id`,
      );
      await db.execute(sql`UPDATE agent_jobs SET status = 'completed' WHERE id = ${head[0]!.id}`);
      const relaunched = await rows<{ task: string; note: string | null; messages: unknown }>(
        db,
        sql`SELECT task, handoff_note AS note, messages FROM agent_jobs
            WHERE relaunched_from_job_id = ${head[0]!.id}`,
      );
      expect(relaunched).toEqual([
        {
          task: 'Un seul trait par chiffre.',
          note: 'Elle corrige le tracé de la feuille.',
          messages: [],
        },
      ]);
    } finally {
      await close();
    }
  });
});
