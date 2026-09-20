// agent-jobs-result-kind.pg.test.ts — migration 0117 contre un VRAI Postgres.
//
// @cap:suivre-execution/moteur
//
// POURQUOI UN FICHIER À PART. `pnpm test` construit sa base depuis le SQL en
// ligne de `helpers.ts`, jamais depuis `migrations/`. Une migration peut donc
// être fausse — ou, pire, absente de `meta/_journal.json`, ce qui la fait
// ignorer EN SILENCE par drizzle-kit — pendant que toute la suite reste verte,
// et seule une vraie mise à jour casse.
//
// Ce que ce fichier prouve, et que la base de test ne prouverait pas : la
// colonne `result_kind` existe APRÈS les vraies migrations, elle est
// NULLABLE et SANS DÉFAUT (un job d'avant la marque n'en reçoit pas une
// inventée), et sa contrainte refuse tout mot hors des deux valeurs que le
// runner pose. Une troisième valeur écrite par erreur serait lue par les
// écrans comme « pas de marque » et retomberait en silence sur l'ancienne
// heuristique — c'est exactement ce que #154 retire.
//
// Mutation vérifiée : l'entrée 117 retirée de `meta/_journal.json` → le
// deuxième test rougit (« result_kind absente après les vraies migrations »).
// Deuxième mutation : la contrainte retirée de la migration → le quatrième
// test rougit (l'insert d'un mot inconnu passe au lieu d'être refusé).

import { describe, it, expect, afterAll } from 'vitest';
import { startRealPostgres, type RealPostgres } from '@nodal-agents/test-kit';
import { createClient, sql, eq, agentJobs, agents, entities, users } from '@nodal-agents/db';
import { runMigrations } from '@nodal-agents/db/migrate';

let pg: RealPostgres | null = null;

afterAll(async () => {
  await pg?.stop();
});

function harness(): RealPostgres {
  if (!pg) expect.fail('REAL_POSTGRES_NOT_STARTED — the startup test failed before this one');
  return pg;
}

/** Les identités semées par le troisième test, relues par les suivants. */
const seme = { entityId: '', agentId: '' };

describe('migration 0117_agent_jobs_result_kind @cap:suivre-execution/moteur', () => {
  it('démarre un vrai Postgres et applique les VRAIES migrations', async () => {
    pg = await startRealPostgres();
    expect(pg.url).toMatch(/^postgresql:\/\//);
    await runMigrations(pg.url, { patchVectorAsText: true });
  }, 120_000);

  it('result_kind existe, en texte NULLABLE et sans défaut', async () => {
    const { db, close } = createClient(harness().url, { max: 1 });
    try {
      const colonnes = (await db.execute(
        sql`SELECT column_name, data_type, is_nullable, column_default
            FROM information_schema.columns
            WHERE table_schema = 'public'
              AND table_name = 'agent_jobs'
              AND column_name = 'result_kind'`,
      )) as unknown as Array<{
        column_name: string;
        data_type: string;
        is_nullable: string;
        column_default: string | null;
      }>;

      expect(colonnes, 'result_kind absente après les vraies migrations').toHaveLength(1);
      const colonne = colonnes[0]!;
      expect(colonne.data_type).toBe('text');
      // NULLABLE : les jobs déjà en base n'ont pas de marque. SANS DÉFAUT : ils
      // n'en reçoivent pas une inventée, et les écrans savent que NULL veut
      // dire « pas de marque » plutôt que « prose ».
      expect(colonne.is_nullable).toBe('YES');
      expect(colonne.column_default).toBeNull();
    } finally {
      await close();
    }
  });

  it('les deux marques du runner s’écrivent, et NULL reste NULL', async () => {
    const { db, close } = createClient(harness().url, { max: 1 });
    try {
      const [u] = await db
        .insert(users)
        .values({ email: 'marque@exemple.test' })
        .returning({ id: users.id });
      const [e] = await db
        .insert(entities)
        .values({ userId: u!.id, name: 'Marque', slug: 'marque' })
        .returning({ id: entities.id });
      seme.entityId = e!.id;
      const [a] = await db
        .insert(agents)
        .values({ entityId: seme.entityId, name: 'Agent', slug: 'agent-marque', personality: '' })
        .returning({ id: agents.id });
      seme.agentId = a!.id;

      const poser = async (kind: 'prose' | 'relay' | null): Promise<string | null> => {
        const [job] = await db
          .insert(agentJobs)
          .values({
            entityId: seme.entityId,
            agentId: seme.agentId,
            channel: 'dashboard',
            task: 'une tâche',
            result: 'un texte',
            ...(kind === null ? {} : { resultKind: kind }),
          })
          .returning({ id: agentJobs.id });
        const [relu] = await db
          .select({ resultKind: agentJobs.resultKind })
          .from(agentJobs)
          .where(eq(agentJobs.id, job!.id));
        return relu!.resultKind ?? null;
      };

      expect(await poser('prose')).toBe('prose');
      expect(await poser('relay')).toBe('relay');
      expect(await poser(null), 'une ligne sans marque en a reçu une').toBeNull();
    } finally {
      await close();
    }
  });

  it('un mot hors des deux marques est REFUSÉ, il ne s’écrit pas en silence', async () => {
    const { db, close } = createClient(harness().url, { max: 1 });
    try {
      // `structured` est précisément le mot que la fiche #154 proposait et
      // qu'aucun chemin du runner ne pose : la contrainte l'arrête plutôt que
      // de laisser une valeur morte traverser jusqu'aux écrans.
      let refus: unknown = null;
      try {
        await db.execute(
          sql`INSERT INTO agent_jobs (entity_id, agent_id, channel, task, result, result_kind)
              VALUES (${seme.entityId}, ${seme.agentId}, 'dashboard', 'une tâche', 'un texte', 'structured')`,
        );
      } catch (err) {
        refus = err;
      }
      expect(refus, 'un mot inconnu a été accepté comme marque').not.toBeNull();

      // La CONTRAINTE nommée, pas un refus quelconque : le pilote range le
      // détail Postgres dans `cause`, et un test qui se contenterait d'un rejet
      // passerait aussi sur une colonne manquante ou une clé étrangère cassée.
      const noms: string[] = [];
      for (let e: unknown = refus; e !== null && e !== undefined; ) {
        const o = e as { message?: unknown; constraint_name?: unknown; cause?: unknown };
        if (typeof o.message === 'string') noms.push(o.message);
        if (typeof o.constraint_name === 'string') noms.push(o.constraint_name);
        e = o.cause ?? null;
      }
      expect(noms.join(' | ')).toContain('agent_jobs_result_kind_check');
    } finally {
      await close();
    }
  });
});
