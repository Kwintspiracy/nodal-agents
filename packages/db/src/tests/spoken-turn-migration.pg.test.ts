// spoken-turn-migration.pg.test.ts — migration 0157 contre un VRAI Postgres.
//
// CE QUE CELA PROUVE (#941) :
//   - `chat_messages.spoken_ms` existe, NULL pour un message écrit sans elle
//     (un message tapé), et la contrainte refuse une durée nulle ou posée sur
//     une réponse de l'agent ;
//   - `agent_jobs.reply_rendering` existe, `text` pour un job écrit sans elle,
//     et refuse une valeur inconnue ;
//   - la relance d'une file (le déclencheur redéfini par 0157) donne à la
//     nouvelle tête la forme de sa racine : un travail lancé à la voix se
//     poursuit à la voix.
// Sans l'entrée du journal, drizzle-kit ignorerait le fichier en silence et
// seul ce test rougirait : la base des tests unitaires est construite en SQL
// inline (CLAUDE.md, « Ajouter une migration »).
//
// Le démarrage est un TEST, pas un `beforeAll` (invariant #4).

import { describe, it, expect, afterAll } from 'vitest';
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

/** The constraint a refused write names: drizzle wraps the driver's error, whose `cause` is Postgres's. */
async function refusedBy(write: Promise<unknown>): Promise<string | undefined> {
  const err = await write.then(
    () => undefined,
    (e: unknown) => e,
  );
  const cause = (err as { cause?: { constraint_name?: string } } | undefined)?.cause;
  return cause?.constraint_name;
}

async function seed(db: Db): Promise<{ entityId: string; agentId: string; convId: string }> {
  const tag = `spoken-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const u = await rows<{ id: string }>(
    db,
    sql`INSERT INTO users (email) VALUES (${`${tag}@example.com`}) RETURNING id`,
  );
  const e = await rows<{ id: string }>(
    db,
    sql`INSERT INTO entities (user_id, name, slug) VALUES (${u[0]!.id}, ${tag}, ${tag}) RETURNING id`,
  );
  const a = await rows<{ id: string }>(
    db,
    sql`INSERT INTO agents (entity_id, name, slug, personality)
        VALUES (${e[0]!.id}, ${tag}, ${tag}, 'p') RETURNING id`,
  );
  const c = await rows<{ id: string }>(
    db,
    sql`INSERT INTO conversations (entity_id, agent_id, channel)
        VALUES (${e[0]!.id}, ${a[0]!.id}, 'dashboard') RETURNING id`,
  );
  return { entityId: e[0]!.id, agentId: a[0]!.id, convId: c[0]!.id };
}

describe('migration 0157_spoken_turn @cap:parler-a-un-agent/moteur', () => {
  it('starts a real Postgres and applies the REAL migrations — red if the binary is missing, not skipped', async () => {
    pg = await startRealPostgres();
    await runMigrations(pg.url, { patchVectorAsText: true });
  }, 120_000);

  it('a message written without the column is typed; a spoken one is the person’s, and lasted', async () => {
    const { db, close } = createClient(harness().url, { max: 1 });
    try {
      const { entityId, agentId, convId } = await seed(db);
      const typed = await rows<{ spoken_ms: number | null }>(
        db,
        sql`INSERT INTO chat_messages (entity_id, agent_id, conversation_id, role, content)
            VALUES (${entityId}, ${agentId}, ${convId}, 'user', 'hello') RETURNING spoken_ms`,
      );
      expect(typed).toEqual([{ spoken_ms: null }]);
      const spoken = await rows<{ spoken_ms: number | null }>(
        db,
        sql`INSERT INTO chat_messages (entity_id, agent_id, conversation_id, role, content, spoken_ms)
            VALUES (${entityId}, ${agentId}, ${convId}, 'user', 'hello', 2265) RETURNING spoken_ms`,
      );
      expect(spoken).toEqual([{ spoken_ms: 2265 }]);
      for (const [role, ms] of [
        ['user', 0],
        ['assistant', 1200],
      ] as const) {
        expect(
          await refusedBy(
            db.execute(
              sql`INSERT INTO chat_messages (entity_id, agent_id, conversation_id, role, content, spoken_ms)
                  VALUES (${entityId}, ${agentId}, ${convId}, ${role}, 'x', ${ms})`,
            ),
          ),
        ).toBe('chat_messages_spoken_ms_check');
      }
    } finally {
      await close();
    }
  });

  it('a job written without the column is read; an unknown rendering is refused', async () => {
    const { db, close } = createClient(harness().url, { max: 1 });
    try {
      const { entityId, agentId } = await seed(db);
      const job = await rows<{ reply_rendering: string }>(
        db,
        sql`INSERT INTO agent_jobs (entity_id, agent_id, channel, task)
            VALUES (${entityId}, ${agentId}, 'dashboard', 't') RETURNING reply_rendering`,
      );
      expect(job).toEqual([{ reply_rendering: 'text' }]);
      expect(
        await refusedBy(
          db.execute(
            sql`INSERT INTO agent_jobs (entity_id, agent_id, channel, task, reply_rendering)
                VALUES (${entityId}, ${agentId}, 'dashboard', 't', 'sung')`,
          ),
        ),
      ).toBe('agent_jobs_reply_rendering_check');
    } finally {
      await close();
    }
  });

  it('the inbox relaunch gives the new head its root’s rendering', async () => {
    const { db, close } = createClient(harness().url, { max: 1 });
    try {
      const { entityId, agentId, convId } = await seed(db);
      const entry = {
        id: 'e1',
        task: 'and tell me when it is done',
        content: 'and tell me when it is done',
        receivedAt: '2026-11-03T10:00:00.000Z',
      };
      const head = await rows<{ id: string }>(
        db,
        sql`INSERT INTO agent_jobs (entity_id, agent_id, channel, task, conversation_id, status,
                                    reply_rendering, inbox)
            VALUES (${entityId}, ${agentId}, 'dashboard', 't', ${convId}, 'processing', 'spoken',
                    ${JSON.stringify([entry])}::jsonb)
            RETURNING id`,
      );
      await db.execute(sql`UPDATE agent_jobs SET status = 'completed' WHERE id = ${head[0]!.id}`);
      const relaunched = await rows<{ task: string; reply_rendering: string }>(
        db,
        sql`SELECT task, reply_rendering FROM agent_jobs WHERE relaunched_from_job_id = ${head[0]!.id}`,
      );
      expect(relaunched).toEqual([
        { task: 'and tell me when it is done', reply_rendering: 'spoken' },
      ]);
    } finally {
      await close();
    }
  });

  it('records the migration in the journal drizzle-kit actually reads', async () => {
    const journal = (await import('../../migrations/meta/_journal.json', {
      with: { type: 'json' },
    })) as { default: { entries: Array<{ idx: number; tag: string }> } };
    expect(journal.default.entries.map((e) => e.tag)).toContain('0157_spoken_turn');
  });
});
