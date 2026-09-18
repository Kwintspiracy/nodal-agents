// tool-calls-seq.pg.test.ts — migration 0110 contre un VRAI Postgres.
//
// @cap:organiser-equipe/moteur
//
// POURQUOI UN FICHIER À PART. `pnpm test` construit sa base depuis le SQL en
// ligne de `helpers.ts`, jamais depuis `migrations/`. Une migration peut donc
// être fausse — ou, pire, absente de `meta/_journal.json`, ce qui la fait
// ignorer EN SILENCE par drizzle-kit — pendant que toute la suite reste verte,
// et seule une vraie mise à jour casse.
//
// Ici l'enjeu n'est pas décoratif : `seq` est la seule colonne qui dise dans
// quel ORDRE deux appels d'un même tour ont été écrits, et la règle « le
// verdict de revue est-il le dernier geste du job ? » en dépend. Sans la
// colonne, un install mis à jour lirait au hasard.

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
  data_type: string;
  is_nullable: string;
  column_default: string | null;
}

describe('migration 0110_tool_calls_seq @cap:organiser-equipe/moteur', () => {
  it('démarre un vrai Postgres et applique les VRAIES migrations', async () => {
    pg = await startRealPostgres();
    expect(pg.url).toMatch(/^postgresql:\/\//);
    await runMigrations(pg.url, { patchVectorAsText: true });
  }, 120_000);

  it('tool_calls.seq existe, en bigint, alimentée par une séquence', async () => {
    const { db, close } = createClient(harness().url, { max: 1 });
    try {
      const rows = (await db.execute(
        sql`SELECT data_type, is_nullable, column_default
            FROM information_schema.columns
            WHERE table_schema = 'public'
              AND table_name = 'tool_calls'
              AND column_name = 'seq'`,
      )) as unknown as ColumnRow[];

      expect(rows, 'tool_calls.seq absente après les vraies migrations').toHaveLength(1);
      expect(rows[0]!.data_type).toBe('bigint');
      // Le défaut EST la séquence : sans lui, chaque insertion laisserait NULL
      // et l'ordre d'écriture serait de nouveau introuvable.
      expect(rows[0]!.column_default ?? '').toContain('nextval');
    } finally {
      await close();
    }
  });

  it('deux insertions de la MÊME heure gardent leur ordre d’écriture', async () => {
    // Le cas qui a motivé la colonne : même tour, même `created_at`, deux
    // outils — `id` est un uuid aléatoire et ne dit rien.
    const { db, close } = createClient(harness().url, { max: 1 });
    try {
      await db.execute(sql`CREATE TABLE IF NOT EXISTS seq_probe (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tool_name text NOT NULL,
        turn integer,
        seq bigserial,
        created_at timestamptz
      )`);
      await db.execute(sql`DELETE FROM seq_probe`);
      const meme = '2026-09-16 10:00:00+00';
      await db.execute(
        sql`INSERT INTO seq_probe (tool_name, turn, created_at) VALUES ('review_verdict', 4, ${meme})`,
      );
      await db.execute(
        sql`INSERT INTO seq_probe (tool_name, turn, created_at) VALUES ('read_file', 4, ${meme})`,
      );

      const rows = (await db.execute(
        sql`SELECT tool_name FROM seq_probe ORDER BY seq DESC LIMIT 1`,
      )) as unknown as Array<{ tool_name: string }>;

      expect(rows[0]!.tool_name).toBe('read_file');
    } finally {
      await close();
    }
  });
});
