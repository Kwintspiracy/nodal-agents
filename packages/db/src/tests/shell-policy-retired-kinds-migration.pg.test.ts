// shell-policy-retired-kinds-migration.pg.test.ts — migration 0128 sur un VRAI Postgres (#464).
//
// Une base qui a fait tourner la première 0125 (PR #474, fermée) porte deux
// sortes d'action que la liste réduite n'a plus. Ce test pose de telles lignes
// APRÈS les vraies migrations, rejoue 0128 telle qu'elle est écrite, et relit :
// les deux clés partent, `own_script` devient `inline_code` quand celui-ci
// n'est pas réglé, une valeur vide redevient NULL, et les raisons retirées
// quittent les demandes.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect, afterAll } from 'vitest';
import { startRealPostgres, type RealPostgres } from '@nodal-agents/test-kit';
import { createClient, sql } from '@nodal-agents/db';
import { runMigrations } from '@nodal-agents/db/migrate';
import { resolveShellPolicy } from '@nodal-agents/shared';

let pg: RealPostgres | null = null;

afterAll(async () => {
  await pg?.stop();
});

function harness(): RealPostgres {
  if (!pg) expect.fail('REAL_POSTGRES_NOT_STARTED — the startup test failed before this one');
  return pg;
}

const E = '00000000-0000-4000-8000-0000000001e1';

const MIGRATION = readFileSync(
  join(import.meta.dirname, '../../migrations/0128_shell_policy_retired_kinds.sql'),
  'utf8',
);

/** Rejoue 0128 telle qu'elle est écrite, ordre par ordre, sur une base déjà migrée. */
async function replay(db: ReturnType<typeof createClient>['db']): Promise<void> {
  for (const statement of MIGRATION.split('--> statement-breakpoint')) {
    await db.execute(sql.raw(statement));
  }
}

describe('migration 0128_shell_policy_retired_kinds @cap:executer-une-commande/moteur', () => {
  it('démarre un vrai Postgres et applique les VRAIES migrations', async () => {
    pg = await startRealPostgres();
    await runMigrations(pg.url, { patchVectorAsText: true });
  }, 120_000);

  // Revue de la PR #497 (Reviewer A) : les cas ci-dessous rejouent le fichier à
  // la main. Sans ce cas-ci, une entrée de journal oubliée laisserait drizzle
  // sauter 0128 pour toujours, tests au vert. La ligne d'historique que le VRAI
  // migrateur écrit porte l'empreinte du fichier appliqué et le `when` du journal.
  it('le vrai migrateur applique 0128 : sa ligne d’historique porte l’empreinte du fichier', async () => {
    const { db, close } = createClient(harness().url, { max: 1 });
    try {
      const rows = (await db.execute(
        sql`SELECT created_at FROM drizzle.__drizzle_migrations WHERE hash = ${createHash('sha256').update(MIGRATION).digest('hex')}`,
      )) as unknown as Array<{ created_at: string | number }>;
      expect(rows.map((r) => Number(r.created_at))).toEqual([1786002000000]);
    } finally {
      await close();
    }
  });

  it('retire les deux sortes, reporte own_script sur inline_code, et laisse les autres lignes', async () => {
    const { db, close } = createClient(harness().url, { max: 1 });
    try {
      await db.execute(sql`INSERT INTO users (id, email) VALUES
        ('00000000-0000-4000-8000-0000000001a1', 'mig128@test.local')`);
      await db.execute(sql`INSERT INTO entities (id, user_id, name, slug) VALUES
        (${E}, '00000000-0000-4000-8000-0000000001a1', 'M', 'mig128')`);
      // Les trois formes vues sur la base du propriétaire le 25/09 (reviewer-c,
      // dev-c : la reprise Yolo de la première 0125 ; excel : un Never posé à
      // la main), plus un agent déjà propre et un agent sans réglage.
      await db.execute(sql`INSERT INTO agents (id, entity_id, name, slug, personality, shell_policy) VALUES
        ('00000000-0000-4000-8000-0000000001b1', ${E}, 'Yolo', 'yolo', 'p',
          '{"outside_folders":"ask","own_script":"allow","delete_files":"allow","install_software":"allow","download":"allow","stop_programs":"allow","system_settings":"allow"}'::jsonb),
        ('00000000-0000-4000-8000-0000000001b2', ${E}, 'Excel', 'excel', 'p', '{"outside_folders":"never"}'::jsonb),
        ('00000000-0000-4000-8000-0000000001b3', ${E}, 'Both', 'both', 'p', '{"own_script":"never","inline_code":"ask"}'::jsonb),
        ('00000000-0000-4000-8000-0000000001b4', ${E}, 'Propre', 'propre', 'p', '{"delete_files":"never"}'::jsonb),
        ('00000000-0000-4000-8000-0000000001b5', ${E}, 'Rien', 'rien', 'p', NULL),
        ('00000000-0000-4000-8000-0000000001b6', ${E}, 'Never', 'never', 'p', '{"own_script":"never"}'::jsonb)`);

      await replay(db);

      const read = async () =>
        (await db.execute(
          sql`SELECT slug, shell_policy FROM agents WHERE entity_id = ${E} ORDER BY slug`,
        )) as unknown as Array<{ slug: string; shell_policy: unknown }>;
      const rows = await read();
      const attendu = [
        // Un réglage déjà posé sur inline_code n'est pas écrasé.
        { slug: 'both', shell_policy: { inline_code: 'ask' } },
        // Plus rien de réglé : NULL, c'est-à-dire « demander » partout.
        { slug: 'excel', shell_policy: null },
        // Une interdiction posée sur own_script survit sur inline_code (revue de la PR #497).
        { slug: 'never', shell_policy: { inline_code: 'never' } },
        { slug: 'propre', shell_policy: { delete_files: 'never' } },
        { slug: 'rien', shell_policy: null },
        {
          slug: 'yolo',
          shell_policy: {
            inline_code: 'allow',
            delete_files: 'allow',
            install_software: 'allow',
            download: 'allow',
            stop_programs: 'allow',
            system_settings: 'allow',
          },
        },
      ];
      expect(rows).toEqual(attendu);
      // Et chaque valeur restante est lisible par le moteur.
      for (const row of rows) expect(() => resolveShellPolicy(row.shell_policy)).not.toThrow();

      // IDEMPOTENTE : un second passage ne change plus rien (revue de la PR #497).
      await replay(db);
      expect(await read()).toEqual(attendu);
    } finally {
      await close();
    }
  });

  it('retire les raisons des deux sortes sur les demandes, et vide celles qui n’avaient qu’elles', async () => {
    const { db, close } = createClient(harness().url, { max: 1 });
    try {
      const [job] = (await db.execute(
        sql`INSERT INTO agent_jobs (entity_id, agent_id, channel, task)
            VALUES (${E}, '00000000-0000-4000-8000-0000000001b4', 'dashboard', 'mig128')
            RETURNING id`,
      )) as unknown as Array<{ id: string }>;
      await db.execute(sql`INSERT INTO approval_requests (id, entity_id, job_id, tool_name, tool_input, status, gate_reasons) VALUES
        ('00000000-0000-4000-8000-0000000001c1', ${E}, ${job!.id}, 'run_command', '{}'::jsonb, 'pending',
          '[{"category":"outside_folders","state":"ask","details":["C:/x"]},{"category":"delete_files","state":"ask","details":["rm x"]},{"state":"ask","details":["sans catégorie"]}]'::jsonb),
        ('00000000-0000-4000-8000-0000000001c2', ${E}, ${job!.id}, 'run_command', '{}'::jsonb, 'pending',
          '[{"category":"own_script","state":"ask","details":["a.py"]}]'::jsonb)`);

      await replay(db);

      const rows = (await db.execute(
        sql`SELECT id, gate_reasons FROM approval_requests WHERE entity_id = ${E} ORDER BY id`,
      )) as unknown as Array<{ id: string; gate_reasons: unknown }>;
      expect(rows).toEqual([
        {
          id: '00000000-0000-4000-8000-0000000001c1',
          // Un élément sans catégorie n'est pas une sorte retirée : il reste
          // (revue de la PR #497 ; `NULL NOT IN (…)` l'écartait en silence).
          gate_reasons: [
            { category: 'delete_files', state: 'ask', details: ['rm x'] },
            { state: 'ask', details: ['sans catégorie'] },
          ],
        },
        { id: '00000000-0000-4000-8000-0000000001c2', gate_reasons: null },
      ]);
    } finally {
      await close();
    }
  });
});
