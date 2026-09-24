// shell-policy-retired-kinds-migration.pg.test.ts — migration 0128 sur un VRAI Postgres (#464).
//
// Une base qui a fait tourner la première 0125 (PR #474, fermée) porte deux
// sortes d'action que la liste réduite n'a plus. Ce test pose de telles lignes
// APRÈS les vraies migrations, rejoue 0128 telle qu'elle est écrite, et relit :
// les deux clés partent, `own_script` devient `inline_code` quand celui-ci
// n'est pas réglé, une valeur vide redevient NULL, et les raisons retirées
// quittent les demandes.

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

describe('migration 0128_shell_policy_retired_kinds @cap:executer-une-commande/moteur', () => {
  it('démarre un vrai Postgres et applique les VRAIES migrations', async () => {
    pg = await startRealPostgres();
    await runMigrations(pg.url, { patchVectorAsText: true });
  }, 120_000);

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
        ('00000000-0000-4000-8000-0000000001b5', ${E}, 'Rien', 'rien', 'p', NULL)`);

      const file = readFileSync(
        join(import.meta.dirname, '../../migrations/0128_shell_policy_retired_kinds.sql'),
        'utf8',
      );
      for (const statement of file.split('--> statement-breakpoint')) {
        await db.execute(sql.raw(statement));
      }

      const rows = (await db.execute(
        sql`SELECT slug, shell_policy FROM agents WHERE entity_id = ${E} ORDER BY slug`,
      )) as unknown as Array<{ slug: string; shell_policy: unknown }>;
      expect(rows).toEqual([
        // Un réglage déjà posé sur inline_code n'est pas écrasé.
        { slug: 'both', shell_policy: { inline_code: 'ask' } },
        // Plus rien de réglé : NULL, c'est-à-dire « demander » partout.
        { slug: 'excel', shell_policy: null },
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
      ]);
      // Et chaque valeur restante est lisible par le moteur.
      for (const row of rows) expect(() => resolveShellPolicy(row.shell_policy)).not.toThrow();
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
          '[{"category":"outside_folders","state":"ask","details":["C:/x"]},{"category":"delete_files","state":"ask","details":["rm x"]}]'::jsonb),
        ('00000000-0000-4000-8000-0000000001c2', ${E}, ${job!.id}, 'run_command', '{}'::jsonb, 'pending',
          '[{"category":"own_script","state":"ask","details":["a.py"]}]'::jsonb)`);

      const file = readFileSync(
        join(import.meta.dirname, '../../migrations/0128_shell_policy_retired_kinds.sql'),
        'utf8',
      );
      for (const statement of file.split('--> statement-breakpoint')) {
        await db.execute(sql.raw(statement));
      }

      const rows = (await db.execute(
        sql`SELECT id, gate_reasons FROM approval_requests WHERE entity_id = ${E} ORDER BY id`,
      )) as unknown as Array<{ id: string; gate_reasons: unknown }>;
      expect(rows).toEqual([
        {
          id: '00000000-0000-4000-8000-0000000001c1',
          gate_reasons: [{ category: 'delete_files', state: 'ask', details: ['rm x'] }],
        },
        { id: '00000000-0000-4000-8000-0000000001c2', gate_reasons: null },
      ]);
    } finally {
      await close();
    }
  });
});
