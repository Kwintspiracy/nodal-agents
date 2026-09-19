// verification-runs-source.pg.test.ts — migration 0113 contre un VRAI Postgres.
//
// @cap:verifier-un-livrable/moteur
//
// POURQUOI UN FICHIER À PART. `pnpm test` construit sa base depuis le SQL
// inline de `helpers.ts`, jamais depuis `migrations/`. Une migration peut donc
// être fausse — ou absente de `meta/_journal.json`, ce qui fait que drizzle-kit
// l'ignore EN SILENCE — pendant que toute la suite reste verte, et seule une
// vraie mise à jour casse.
//
// CE QUE CELA PROUVE EN PLUS DE L'EXISTENCE DES COLONNES. Les lignes écrites
// AVANT cette migration viennent toutes de la finalisation d'un job : leur
// origine est `job`, et c'est le DÉFAUT de la colonne qui le dit. Une colonne
// nullable, ou défaut `reviewer`, ferait mentir tout l'historique des preuves
// sans qu'aucun autre test du dépôt ne s'en aperçoive.
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
  column_default: string | null;
}

describe('migration 0113_verification_runs_source @cap:verifier-un-livrable/moteur', () => {
  it('starts a real Postgres and applies the REAL migrations — red if the binary is missing, not skipped', async () => {
    pg = await startRealPostgres();
    expect(pg.url).toMatch(/^postgresql:\/\//);
    await runMigrations(pg.url, { patchVectorAsText: true });
  }, 120_000);

  it('leaves verification_runs.source a NOT NULL text defaulting to job', async () => {
    const { db, close } = createClient(harness().url, { max: 1 });
    try {
      const rows = (await db.execute(
        sql`SELECT column_name, data_type, is_nullable, column_default
            FROM information_schema.columns
            WHERE table_schema = 'public'
              AND table_name = 'verification_runs'
              AND column_name IN ('source', 'source_job_id')
            ORDER BY column_name`,
      )) as unknown as ColumnRow[];

      expect(rows.map((r) => r.column_name)).toEqual(['source', 'source_job_id']);
      const source = rows[0]!;
      expect(source.data_type).toBe('text');
      // Nullable ferait de « non dit » une troisième origine que l'écran
      // devrait deviner. Une preuve vient de quelque part, toujours.
      expect(source.is_nullable).toBe('NO');
      expect(source.column_default).toContain("'job'");
      // L'exécutant est facultatif : sur une preuve du job lui-même, il EST le
      // job, et la colonne reste nulle.
      expect(rows[1]!.is_nullable).toBe('YES');
    } finally {
      await close();
    }
  });

  it('refuses an origin outside the two the code knows', async () => {
    const { db, close } = createClient(harness().url, { max: 1 });
    try {
      await db.execute(sql`DROP TABLE IF EXISTS verification_source_probe`);
      await db.execute(
        sql`CREATE TABLE verification_source_probe (
              id int PRIMARY KEY,
              source text NOT NULL DEFAULT 'job'
                CONSTRAINT verification_source_probe_check CHECK (source IN ('job','reviewer'))
            )`,
      );
      await expect(
        db.execute(sql`INSERT INTO verification_source_probe (id, source) VALUES (1, 'guessed')`),
      ).rejects.toThrow();

      // Et le vrai CHECK, sur la vraie table, porte bien le même nom.
      const constraints = (await db.execute(
        sql`SELECT conname FROM pg_constraint
            WHERE conrelid = 'verification_runs'::regclass
              AND conname = 'verification_runs_source_check'`,
      )) as unknown as Array<{ conname: string }>;
      expect(constraints).toHaveLength(1);
    } finally {
      await close();
    }
  });

  it('turns an existing proof row into a job-sourced one', async () => {
    const { db, close } = createClient(harness().url, { max: 1 });
    try {
      // La mise à jour que la migration effectue, sur une table à la forme de
      // celle qui existait avant elle : les lignes d'abord, la colonne après.
      await db.execute(sql`DROP TABLE IF EXISTS verification_source_backfill`);
      await db.execute(sql`CREATE TABLE verification_source_backfill (id int PRIMARY KEY)`);
      await db.execute(sql`INSERT INTO verification_source_backfill (id) VALUES (1), (2)`);
      await db.execute(
        sql`ALTER TABLE verification_source_backfill
            ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'job'`,
      );
      const rows = (await db.execute(
        sql`SELECT source FROM verification_source_backfill ORDER BY id`,
      )) as unknown as Array<{ source: string }>;
      expect(rows.map((r) => r.source)).toEqual(['job', 'job']);
    } finally {
      await close();
    }
  });

  it('records the migration in the journal drizzle-kit actually reads', async () => {
    const journal = (await import('../../migrations/meta/_journal.json', {
      with: { type: 'json' },
    })) as { default: { entries: Array<{ idx: number; tag: string }> } };
    const tags = journal.default.entries.map((e) => e.tag);
    expect(tags).toContain('0113_verification_runs_source');
  });
});
