// real-postgres.pg.test.ts — le harnais Postgres réel existe, applique les
// VRAIES migrations, et deux connexions se verrouillent réellement l'une
// l'autre. C'est le socle des tests d'interleaving du plan « Vérifier &
// Corriger » (T14) : sans lui, un `FOR UPDATE` ne se prouve pas.
//
// Le démarrage est un TEST, pas un beforeAll : un beforeAll qui lève marque
// les tests « skipped », et un test sauté en silence est un faux vert
// (invariant #4). Ici un harnais absent = un test rouge nommé, et les
// suivants échouent en le disant. Jamais `describe.skipIf`.

import { describe, it, expect, afterAll } from 'vitest';
import { startRealPostgres, type RealPostgres } from '@nodal-agents/test-kit';
import { createClient, sql } from '@nodal-agents/db';
import { runMigrations } from '@nodal-agents/db/migrate';

let pg: RealPostgres | null = null;

afterAll(async () => {
  await pg?.stop();
});

function harness(): RealPostgres {
  if (!pg) expect.fail('REAL_POSTGRES_NOT_STARTED — le test de démarrage a échoué avant');
  return pg;
}

describe('harnais Postgres réel', () => {
  it('démarre, et applique les VRAIES migrations — rouge si le binaire manque, pas sauté', async () => {
    pg = await startRealPostgres();
    expect(pg.url).toMatch(/^postgresql:\/\//);
    // Les vraies migrations 0000→N — pas le DDL inline de helpers.ts. Aucun
    // pgvector dans le Postgres embarqué : les colonnes vector sont réécrites
    // en text, exactement comme `nodal-agents up` sur une machine sans
    // l'extension.
    await runMigrations(pg.url, { patchVectorAsText: true });
  }, 120_000);

  it('les tables du produit existent après les vraies migrations', async () => {
    const { db, close } = createClient(harness().url, { max: 1 });
    try {
      const rows = await db.execute(
        sql`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name`,
      );
      const names = (rows as unknown as Array<{ table_name: string }>).map((r) => r.table_name);
      for (const expected of [
        'agent_jobs',
        'agents',
        'entities',
        'code_projects',
        'workspace_locks',
      ]) {
        expect(names, `table ${expected} absente`).toContain(expected);
      }
    } finally {
      await close();
    }
  });

  it('deux connexions se verrouillent VRAIMENT : FOR UPDATE sur B attend le COMMIT de A', async () => {
    const url = harness().url;
    const a = createClient(url, { max: 1 });
    const b = createClient(url, { max: 1 });
    try {
      await a.db.execute(sql`CREATE TABLE IF NOT EXISTS lock_probe (id int PRIMARY KEY)`);
      await a.db.execute(sql`INSERT INTO lock_probe (id) VALUES (1) ON CONFLICT DO NOTHING`);

      const HOLD_MS = 800;
      let aCommittedAt = 0;
      // A prend le verrou et le garde HOLD_MS avant de committer.
      const holder = a.db.transaction(async (tx) => {
        await tx.execute(sql`SELECT id FROM lock_probe WHERE id = 1 FOR UPDATE`);
        await new Promise((r) => setTimeout(r, HOLD_MS));
        aCommittedAt = Date.now();
      });
      // B démarre un peu après et tente le même verrou : il doit ATTENDRE.
      await new Promise((r) => setTimeout(r, 150));
      const bStartedAt = Date.now();
      let bAcquiredAt = 0;
      const waiter = b.db.transaction(async (tx) => {
        await tx.execute(sql`SELECT id FROM lock_probe WHERE id = 1 FOR UPDATE`);
        bAcquiredAt = Date.now();
      });
      await Promise.all([holder, waiter]);

      // Sur PGlite mono-connexion, B n'aurait même pas pu démarrer avant la
      // fin de A ; ici B a démarré PENDANT A et a attendu le COMMIT.
      expect(bAcquiredAt).toBeGreaterThanOrEqual(aCommittedAt);
      expect(bAcquiredAt - bStartedAt).toBeGreaterThanOrEqual(HOLD_MS - 150 - 50);
    } finally {
      await a.close();
      await b.close();
    }
  });
});
