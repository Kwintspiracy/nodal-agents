// file-move-rules-migration.pg.test.ts — migration 0154 contre un VRAI Postgres.
//
// @cap:approuver-une-action/moteur
//
// CE QUE CELA PROUVE (#879) : `file_move`, nouvel outil d'écriture toujours
// donné, démarre avec la décision que le propriétaire a déjà prise sur
// `file_write`. Sans elle, un agent dont `file_write` est bloqué (un relecteur
// en lecture seule) aurait pu déplacer des fichiers au premier démarrage de la
// nouvelle version : un élargissement silencieux.
//
//   - un agent qui BLOQUE file_write est bloqué sur file_move ;
//   - un agent en auto_approve passe en auto_approve, un agent qui demande
//     demande, avec la même condition de dossier ;
//   - une règle « tous les agents » (agent_id nul) est reprise elle aussi ;
//   - un agent SANS règle sur file_write n'a rien ;
//   - une règle file_move déjà posée n'est pas écrasée, et rejouer ne double rien.
//
// Les lignes d'avant se posent APRÈS les migrations, puis le fichier 0154
// (idempotent) est rejoué : c'est l'état d'une base qui monte de version.
//
// Le démarrage est un TEST, pas un `beforeAll` (invariant #4).

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

async function espace(db: Db, slug: string): Promise<string> {
  const u = await rows<{ id: string }>(
    db,
    sql`INSERT INTO users (email) VALUES (${`${slug}@example.com`}) RETURNING id`,
  );
  const e = await rows<{ id: string }>(
    db,
    sql`INSERT INTO entities (user_id, name, slug) VALUES (${u[0]!.id}, ${slug}, ${slug}) RETURNING id`,
  );
  return e[0]!.id;
}

async function agent(db: Db, entityId: string, slug: string): Promise<string> {
  const a = await rows<{ id: string }>(
    db,
    sql`INSERT INTO agents (entity_id, name, slug, personality)
        VALUES (${entityId}, ${slug}, ${slug}, 'p') RETURNING id`,
  );
  return a[0]!.id;
}

async function regle(
  db: Db,
  entityId: string,
  agentId: string | null,
  tool: string,
  action: string,
  condition: Record<string, unknown> = {},
): Promise<void> {
  await db.execute(
    sql`INSERT INTO approval_rules (entity_id, agent_id, tool_name, action, condition_json)
        VALUES (${entityId}, ${agentId}, ${tool}, ${action}, ${JSON.stringify(condition)}::jsonb)`,
  );
}

const MIGRATION = fileURLToPath(
  new URL('../../migrations/0154_file_move_rules.sql', import.meta.url),
);

describe('migration 0154_file_move_rules @cap:approuver-une-action/moteur', () => {
  it('starts a real Postgres and applies the REAL migrations — red if the binary is missing, not skipped', async () => {
    pg = await startRealPostgres();
    await runMigrations(pg.url, { patchVectorAsText: true });
  }, 120_000);

  it('file_move inherits the owner’s decision on file_write, for every agent that has one, and nothing else', async () => {
    const { db, close } = createClient(harness().url, { max: 1 });
    try {
      const e = await espace(db, `file-move-${Date.now()}`);
      const relecteur = await agent(db, e, `relecteur-${Date.now()}`);
      const libre = await agent(db, e, `libre-${Date.now()}`);
      const prudent = await agent(db, e, `prudent-${Date.now()}`);
      const sansRegle = await agent(db, e, `sans-regle-${Date.now()}`);
      const dejaRegle = await agent(db, e, `deja-${Date.now()}`);

      await regle(db, e, relecteur, 'file_write', 'block');
      await regle(db, e, relecteur, 'file_edit', 'block');
      await regle(db, e, libre, 'file_write', 'auto_approve');
      await regle(db, e, prudent, 'file_write', 'require_approval', {
        workspacePath: 'D:/ws/rapports',
      });
      await regle(db, e, sansRegle, 'file_edit', 'block');
      await regle(db, e, dejaRegle, 'file_write', 'block');
      await regle(db, e, dejaRegle, 'file_move', 'auto_approve');
      // « Tous les agents » de l'espace.
      await regle(db, e, null, 'file_write', 'require_approval');

      const sql0154 = readFileSync(MIGRATION, 'utf8');
      await db.execute(sql.raw(sql0154));
      // Rejouée : idempotente.
      await db.execute(sql.raw(sql0154));

      const moves = await rows<{
        agent_id: string | null;
        action: string;
        condition_json: unknown;
      }>(
        db,
        sql`SELECT agent_id, action, condition_json FROM approval_rules
            WHERE entity_id = ${e} AND tool_name = 'file_move'`,
      );
      const parAgent = new Map(moves.map((m) => [m.agent_id, m]));

      expect(parAgent.get(relecteur)?.action, 'un relecteur bloqué pourrait déplacer').toBe(
        'block',
      );
      expect(parAgent.get(libre)?.action).toBe('auto_approve');
      expect(parAgent.get(prudent)).toMatchObject({
        action: 'require_approval',
        condition_json: { workspacePath: 'D:/ws/rapports' },
      });
      expect(parAgent.get(null)?.action, 'la règle de tous les agents est perdue').toBe(
        'require_approval',
      );
      // Rien n'est inventé là où le propriétaire n'a rien décidé sur file_write.
      expect(parAgent.has(sansRegle)).toBe(false);
      // Une règle déjà posée n'est pas écrasée.
      expect(parAgent.get(dejaRegle)?.action).toBe('auto_approve');
      // Une ligne par (agent, outil), même rejouée deux fois.
      expect(moves).toHaveLength(5);
    } finally {
      await close();
    }
  });

  it('records the migration in the journal drizzle-kit actually reads', async () => {
    const journal = (await import('../../migrations/meta/_journal.json', {
      with: { type: 'json' },
    })) as { default: { entries: Array<{ idx: number; tag: string }> } };
    expect(journal.default.entries.map((e) => e.tag)).toContain('0154_file_move_rules');
  });
});
