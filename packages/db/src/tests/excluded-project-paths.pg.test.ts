// excluded-project-paths.pg.test.ts — migration 0120 contre un VRAI Postgres.
//
// @cap:travailler-sur-des-fichiers/moteur
//
// POURQUOI UN FICHIER À PART. `pnpm test` construit sa base depuis le SQL
// inline de `helpers.ts`, jamais depuis `migrations/`. Une migration peut donc
// être fausse — ou absente de `meta/_journal.json`, ce qui fait que drizzle-kit
// l'ignore EN SILENCE — pendant que toute la suite reste verte, et seule une
// vraie mise à jour casse.
//
// CE QUE CELA PROUVE EN PLUS DE L'EXISTENCE DE LA TABLE. L'unicité porte sur
// (`entity_id`, `project_key`) et non sur le chemin : sous Windows le même
// dossier remonte avec des casses différentes selon la session, et une unicité
// sur `project_path` laisserait deux exclusions du même dossier coexister. Un
// test qui se contenterait de créer la table ne verrait rien de cela.
//
// Le démarrage est un TEST, pas un `beforeAll` : un `beforeAll` qui lève marque
// les tests « sautés », et un test sauté en silence est un faux vert (inv. #4).

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

interface ColumnRow {
  column_name: string;
  data_type: string;
  is_nullable: string;
}

/** Un espace jetable, avec son utilisateur — la FK exige les deux. */
async function espace(db: ReturnType<typeof createClient>['db'], slug: string): Promise<string> {
  const users = (await db.execute(
    sql`INSERT INTO users (email) VALUES (${`${slug}@example.com`}) RETURNING id`,
  )) as unknown as Array<{ id: string }>;
  const entities = (await db.execute(
    sql`INSERT INTO entities (user_id, name, slug)
        VALUES (${users[0]!.id}, ${slug}, ${slug}) RETURNING id`,
  )) as unknown as Array<{ id: string }>;
  return entities[0]!.id;
}

describe('migration 0120_excluded_project_paths @cap:travailler-sur-des-fichiers/moteur', () => {
  it('starts a real Postgres and applies the REAL migrations — red if the binary is missing, not skipped', async () => {
    pg = await startRealPostgres();
    expect(pg.url).toMatch(/^postgresql:\/\//);
    await runMigrations(pg.url, { patchVectorAsText: true });
  }, 120_000);

  it('carries the four columns the exclusion needs, all required but the id default', async () => {
    const { db, close } = createClient(harness().url, { max: 1 });
    try {
      const rows = (await db.execute(
        sql`SELECT column_name, data_type, is_nullable
            FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = 'excluded_project_paths'
            ORDER BY column_name`,
      )) as unknown as ColumnRow[];

      expect(rows.map((r) => r.column_name)).toEqual([
        'created_at',
        'entity_id',
        'id',
        'project_key',
        'project_path',
      ]);
      // Rien de NULLABLE : une exclusion sans espace, sans chemin ou sans clé
      // ne veut rien dire, et la détection ne saurait pas quoi en faire.
      expect(rows.every((r) => r.is_nullable === 'NO')).toBe(true);
      expect(rows.find((r) => r.column_name === 'project_key')?.data_type).toBe('text');
      expect(rows.find((r) => r.column_name === 'created_at')?.data_type).toBe(
        'timestamp with time zone',
      );
    } finally {
      await close();
    }
  });

  it('refuses a second exclusion of the same folder in the same space, and allows it in another', async () => {
    const { db, close } = createClient(harness().url, { max: 1 });
    try {
      const un = await espace(db, `excl-un-${Date.now()}`);
      const deux = await espace(db, `excl-deux-${Date.now()}`);

      await db.execute(
        sql`INSERT INTO excluded_project_paths (entity_id, project_path, project_key)
            VALUES (${un}, ${'D:/APPS/demo'}, ${'d:/apps/demo'})`,
      );
      // La MÊME clé dans le MÊME espace : refusée, quelle que soit la casse du
      // chemin affiché. C'est tout l'intérêt de porter l'unicité sur la clé.
      await expect(
        db.execute(
          sql`INSERT INTO excluded_project_paths (entity_id, project_path, project_key)
              VALUES (${un}, ${'D:/Apps/Demo'}, ${'d:/apps/demo'})`,
        ),
      ).rejects.toThrow();

      // Le MÊME dossier chez le voisin : accepté. Une exclusion est un réglage
      // d'espace, pas une propriété du disque.
      await db.execute(
        sql`INSERT INTO excluded_project_paths (entity_id, project_path, project_key)
            VALUES (${deux}, ${'D:/APPS/demo'}, ${'d:/apps/demo'})`,
      );

      const count = (await db.execute(
        sql`SELECT count(*)::int AS n FROM excluded_project_paths
            WHERE project_key = ${'d:/apps/demo'}`,
      )) as unknown as Array<{ n: number }>;
      expect(count[0]!.n).toBe(2);
    } finally {
      await close();
    }
  });

  it('drops the exclusions of a space that is deleted', async () => {
    const { db, close } = createClient(harness().url, { max: 1 });
    try {
      const id = await espace(db, `excl-cascade-${Date.now()}`);
      await db.execute(
        sql`INSERT INTO excluded_project_paths (entity_id, project_path, project_key)
            VALUES (${id}, ${'D:/APPS/parti'}, ${'d:/apps/parti'})`,
      );
      await db.execute(sql`DELETE FROM entities WHERE id = ${id}`);
      const reste = (await db.execute(
        sql`SELECT count(*)::int AS n FROM excluded_project_paths WHERE entity_id = ${id}`,
      )) as unknown as Array<{ n: number }>;
      expect(reste[0]!.n).toBe(0);
    } finally {
      await close();
    }
  });

  it('records the migration in the journal drizzle-kit actually reads', async () => {
    const journal = (await import('../../migrations/meta/_journal.json', {
      with: { type: 'json' },
    })) as { default: { entries: Array<{ idx: number; tag: string }> } };
    const tags = journal.default.entries.map((e) => e.tag);
    expect(tags).toContain('0120_excluded_project_paths');
  });
});
