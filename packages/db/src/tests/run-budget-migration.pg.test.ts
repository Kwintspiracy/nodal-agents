// run-budget-migration.pg.test.ts — migration 0126 contre un VRAI Postgres.
//
// @cap:suivre-execution/moteur
//
// POURQUOI UN FICHIER À PART : `pnpm test` construit sa base depuis le SQL
// inline de `helpers.ts`, jamais depuis `migrations/`. Une migration fausse, ou
// absente du journal, laisse toute la suite verte.
//
// CE QUE CELA PROUVE (#442) :
//   - les deux réglages de l'espace existent avec les défauts qui ne changent
//     le comportement de personne : 2 $ (le plafond que le runner appliquait
//     déjà) et 0 heure (aucune limite, comme avant) ;
//   - le délai de l'agent est NULL par défaut : la plateforme décide ;
//   - les CHECK refusent ce qui ferait tourner une boucle sans fin (invariant
//     #8) : un plafond négatif ou démesuré, un délai de quelques secondes.
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

type Db = ReturnType<typeof createClient>['db'];

/** Un espace jetable, avec son utilisateur et un agent. */
async function espace(db: Db, slug: string): Promise<{ entityId: string; agentId: string }> {
  const users = (await db.execute(
    sql`INSERT INTO users (email) VALUES (${`${slug}@example.com`}) RETURNING id`,
  )) as unknown as Array<{ id: string }>;
  const ents = (await db.execute(
    sql`INSERT INTO entities (user_id, name, slug)
        VALUES (${users[0]!.id}, ${slug}, ${slug}) RETURNING id`,
  )) as unknown as Array<{ id: string }>;
  const ags = (await db.execute(
    sql`INSERT INTO agents (entity_id, name, slug, personality)
        VALUES (${ents[0]!.id}, ${slug}, ${slug}, 'p') RETURNING id`,
  )) as unknown as Array<{ id: string }>;
  return { entityId: ents[0]!.id, agentId: ags[0]!.id };
}

describe('migration 0126_run_budget @cap:suivre-execution/moteur', () => {
  it('starts a real Postgres and applies the REAL migrations — red if the binary is missing, not skipped', async () => {
    pg = await startRealPostgres();
    expect(pg.url).toMatch(/^postgresql:\/\//);
    await runMigrations(pg.url, { patchVectorAsText: true });
  }, 120_000);

  it('les défauts ne changent le comportement de personne', async () => {
    const { db, close } = createClient(harness().url, { max: 1 });
    try {
      const { entityId, agentId } = await espace(db, `budget-defaut-${Date.now()}`);
      const e = (await db.execute(
        sql`SELECT max_run_cost_usd AS cost, max_run_hours AS hours FROM entities WHERE id = ${entityId}`,
      )) as unknown as Array<{ cost: number; hours: number }>;
      expect(e[0]).toEqual({ cost: 2, hours: 0 });
      const a = (await db.execute(
        sql`SELECT idle_timeout_seconds AS s FROM agents WHERE id = ${agentId}`,
      )) as unknown as Array<{ s: number | null }>;
      expect(a[0]!.s).toBeNull();
    } finally {
      await close();
    }
  });

  it('accepte les bornes, et REFUSE ce qui est en dehors', async () => {
    const { db, close } = createClient(harness().url, { max: 1 });
    try {
      const { entityId, agentId } = await espace(db, `budget-bornes-${Date.now()}`);

      await db.execute(
        sql`UPDATE entities SET max_run_cost_usd = 0, max_run_hours = 72 WHERE id = ${entityId}`,
      );
      await db.execute(
        sql`UPDATE entities SET max_run_cost_usd = 1000, max_run_hours = 0.5 WHERE id = ${entityId}`,
      );
      await db.execute(sql`UPDATE agents SET idle_timeout_seconds = 30 WHERE id = ${agentId}`);
      await db.execute(sql`UPDATE agents SET idle_timeout_seconds = 3600 WHERE id = ${agentId}`);

      for (const bad of [
        sql`UPDATE entities SET max_run_cost_usd = -1 WHERE id = ${entityId}`,
        sql`UPDATE entities SET max_run_cost_usd = 1001 WHERE id = ${entityId}`,
        sql`UPDATE entities SET max_run_hours = -0.1 WHERE id = ${entityId}`,
        sql`UPDATE entities SET max_run_hours = 73 WHERE id = ${entityId}`,
        sql`UPDATE agents SET idle_timeout_seconds = 5 WHERE id = ${agentId}`,
        sql`UPDATE agents SET idle_timeout_seconds = 3601 WHERE id = ${agentId}`,
      ]) {
        await expect(db.execute(bad)).rejects.toThrow();
      }

      // Les dernières valeurs ACCEPTÉES sont restées : un refus n'écrit rien.
      const e = (await db.execute(
        sql`SELECT max_run_cost_usd AS cost, max_run_hours AS hours FROM entities WHERE id = ${entityId}`,
      )) as unknown as Array<{ cost: number; hours: number }>;
      expect(e[0]).toEqual({ cost: 1000, hours: 0.5 });
      const a = (await db.execute(
        sql`SELECT idle_timeout_seconds AS s FROM agents WHERE id = ${agentId}`,
      )) as unknown as Array<{ s: number }>;
      expect(a[0]!.s).toBe(3600);
    } finally {
      await close();
    }
  });

  it('records the migration in the journal drizzle-kit actually reads', async () => {
    const journal = (await import('../../migrations/meta/_journal.json', {
      with: { type: 'json' },
    })) as { default: { entries: Array<{ idx: number; tag: string }> } };
    expect(journal.default.entries.map((e) => e.tag)).toContain('0126_run_budget');
  });
});
