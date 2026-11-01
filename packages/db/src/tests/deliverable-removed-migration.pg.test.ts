// deliverable-removed-migration.pg.test.ts — migration 0155 contre un VRAI Postgres.
//
// @cap:verifier-un-livrable/moteur
//
// CE QUE CELA PROUVE (#916) : la colonne `removed` existe après les VRAIES
// migrations, à `false` pour une ligne écrite sans elle — aucune ligne d'avant
// n'a été observée retirée. Sans l'entrée du journal, drizzle-kit ignorerait le
// fichier en silence et seul ce test rougirait : la base des tests unitaires
// est construite en SQL inline (CLAUDE.md, « Ajouter une migration »).
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

describe('migration 0155_deliverable_removed @cap:verifier-un-livrable/moteur', () => {
  it('starts a real Postgres and applies the REAL migrations — red if the binary is missing, not skipped', async () => {
    pg = await startRealPostgres();
    await runMigrations(pg.url, { patchVectorAsText: true });
  }, 120_000);

  it('a state row written without the columns reads removed = false, removed_size = null', async () => {
    const { db, close } = createClient(harness().url);
    try {
      const u = await rows<{ id: string }>(
        db,
        sql`INSERT INTO users (email) VALUES ('removed@example.com') RETURNING id`,
      );
      const e = await rows<{ id: string }>(
        db,
        sql`INSERT INTO entities (user_id, name, slug) VALUES (${u[0]!.id}, 'r', 'r') RETURNING id`,
      );
      const a = await rows<{ id: string }>(
        db,
        sql`INSERT INTO agents (entity_id, name, slug, personality)
            VALUES (${e[0]!.id}, 'r', 'r', 'p') RETURNING id`,
      );
      const j = await rows<{ id: string }>(
        db,
        sql`INSERT INTO agent_jobs (entity_id, agent_id, channel, task)
            VALUES (${e[0]!.id}, ${a[0]!.id}, 'api', 't') RETURNING id`,
      );
      const s = await rows<{ removed: boolean; removed_size: string | null }>(
        db,
        sql`INSERT INTO job_deliverable_verification_state
              (job_id, deliverable_type, canonical_key, dirty_generation, decision_status)
            VALUES (${j[0]!.id}, 'document', 'd:/ws/a.md', 1, 'dirty')
            RETURNING removed, removed_size`,
      );
      expect(s[0]!.removed).toBe(false);
      expect(s[0]!.removed_size).toBeNull();
    } finally {
      await close();
    }
  });

  it('records the migration in the journal drizzle-kit actually reads', async () => {
    const journal = (await import('../../migrations/meta/_journal.json', {
      with: { type: 'json' },
    })) as { default: { entries: Array<{ idx: number; tag: string }> } };
    expect(journal.default.entries.map((e) => e.tag)).toContain('0155_deliverable_removed');
  });
});
