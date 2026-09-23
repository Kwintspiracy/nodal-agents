// shell-checklist-migration.pg.test.ts — migration 0125 sur un VRAI Postgres (#464).
//
// `spinUpTestDb` construit sa base en SQL écrit à la main : une migration
// absente du journal y passerait inaperçue. Ce test applique les VRAIES
// migrations, prouve que les deux colonnes arrivent, et rejoue la reprise des
// agents « Yolo » sur des lignes posées ici : un agent qui avait déjà le shell
// sans demander garde tout, SAUF sortir de ses dossiers ; les autres restent à NULL.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
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

describe('migration 0125_shell_checklist @cap:executer-une-commande/moteur', () => {
  it('démarre un vrai Postgres et applique les VRAIES migrations', async () => {
    pg = await startRealPostgres();
    await runMigrations(pg.url, { patchVectorAsText: true });
  }, 120_000);

  it('agents.shell_policy et approval_requests.gate_reasons existent : jsonb, facultatifs', async () => {
    const { db, close } = createClient(harness().url, { max: 1 });
    try {
      const colonnes = (await db.execute(
        sql`SELECT table_name, data_type, is_nullable
            FROM information_schema.columns
            WHERE table_schema = 'public'
              AND ((table_name = 'agents' AND column_name = 'shell_policy')
                OR (table_name = 'approval_requests' AND column_name = 'gate_reasons'))
            ORDER BY table_name`,
      )) as unknown as Array<{ table_name: string; data_type: string; is_nullable: string }>;
      expect(colonnes).toEqual([
        { table_name: 'agents', data_type: 'jsonb', is_nullable: 'YES' },
        { table_name: 'approval_requests', data_type: 'jsonb', is_nullable: 'YES' },
      ]);
    } finally {
      await close();
    }
  });

  it('la reprise : un agent Yolo (sans condition) garde tout sauf sortir de ses dossiers ; les autres restent à NULL', async () => {
    const { db, close } = createClient(harness().url, { max: 1 });
    try {
      await db.execute(sql`INSERT INTO users (id, email) VALUES
        ('00000000-0000-4000-8000-0000000000a1', 'mig125@test.local')`);
      await db.execute(sql`INSERT INTO entities (id, user_id, name, slug) VALUES
        ('00000000-0000-4000-8000-0000000000e1', '00000000-0000-4000-8000-0000000000a1', 'M', 'mig125')`);
      await db.execute(sql`INSERT INTO agents (id, entity_id, name, slug, personality) VALUES
        ('00000000-0000-4000-8000-0000000000b1', '00000000-0000-4000-8000-0000000000e1', 'Yolo', 'yolo', 'p'),
        ('00000000-0000-4000-8000-0000000000b2', '00000000-0000-4000-8000-0000000000e1', 'Prudent', 'prudent', 'p'),
        ('00000000-0000-4000-8000-0000000000b3', '00000000-0000-4000-8000-0000000000e1', 'Bloque', 'bloque', 'p'),
        ('00000000-0000-4000-8000-0000000000b4', '00000000-0000-4000-8000-0000000000e1', 'Dossier', 'dossier', 'p')`);
      await db.execute(sql`INSERT INTO approval_rules (entity_id, agent_id, tool_name, action) VALUES
        ('00000000-0000-4000-8000-0000000000e1', '00000000-0000-4000-8000-0000000000b1', 'run_command', 'auto_approve'),
        ('00000000-0000-4000-8000-0000000000e1', '00000000-0000-4000-8000-0000000000b3', 'run_command', 'block')`);
      // Yolo confiné à un dossier (#360) : ne vaut que là, et la reprise ne
      // doit pas l'étendre à toute la liste (revue Codex de #464, P1).
      await db.execute(sql`INSERT INTO approval_rules (entity_id, agent_id, tool_name, action, condition_json) VALUES
        ('00000000-0000-4000-8000-0000000000e1', '00000000-0000-4000-8000-0000000000b4', 'run_command', 'auto_approve', '{"workspacePath":"D:/dev"}'::jsonb)`);

      // La reprise est le TROISIÈME ordre du fichier de migration, rejoué tel quel.
      const file = readFileSync(
        join(import.meta.dirname, '../../migrations/0125_shell_checklist.sql'),
        'utf8',
      );
      const reprise = file.split('--> statement-breakpoint')[2];
      if (!reprise) expect.fail('0125 has no third statement');
      await db.execute(sql.raw(reprise));

      const rows = (await db.execute(
        sql`SELECT slug, shell_policy FROM agents WHERE entity_id = '00000000-0000-4000-8000-0000000000e1' ORDER BY slug`,
      )) as unknown as Array<{ slug: string; shell_policy: unknown }>;
      expect(rows).toEqual([
        { slug: 'bloque', shell_policy: null },
        { slug: 'dossier', shell_policy: null },
        { slug: 'prudent', shell_policy: null },
        {
          slug: 'yolo',
          shell_policy: {
            outside_folders: 'ask',
            own_script: 'allow',
            delete_files: 'allow',
            install_software: 'allow',
            download: 'allow',
            stop_programs: 'allow',
            system_settings: 'allow',
          },
        },
      ]);
    } finally {
      await close();
    }
  });
});
