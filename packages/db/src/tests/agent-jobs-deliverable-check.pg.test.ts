// agent-jobs-deliverable-check.pg.test.ts — migration 0118 contre un VRAI
// Postgres (#255).
//
// @cap:verifier-un-livrable/moteur
//
// POURQUOI UN FICHIER À PART. `pnpm test` construit sa base depuis le SQL en
// ligne de `helpers.ts`, jamais depuis `migrations/`. Une migration peut donc
// être fausse — ou, pire, absente de `meta/_journal.json`, ce qui la fait
// ignorer EN SILENCE par drizzle-kit — pendant que toute la suite reste verte,
// et seule une vraie mise à jour casse.
//
// Ce que ce fichier prouve, et que la base de test ne prouverait pas :
//
//   1. la colonne `deliverable_check_due_at` existe APRÈS les vraies
//      migrations, en timestamp avec fuseau, NULLABLE et SANS DÉFAUT — les
//      runs déjà finis n'ont livré à personne et ne reçoivent pas un regard en
//      attente inventé après coup ;
//   2. l'index PARTIEL qui sert la pastille existe, et il est bien partiel :
//      sans son `WHERE`, il porterait une entrée par job de la table alors que
//      la pastille ne s'intéresse qu'à ce qui attend encore ;
//   3. la colonne se pose et se RELÂCHE : une valeur écrite se relit, et la
//      remettre à NULL est ce qui éteint la pastille. C'est le cycle entier du
//      fait, sur de vraies lignes.
//
// Mutations vérifiées :
//   - l'entrée 118 retirée de `meta/_journal.json` → le deuxième test rougit
//     (« deliverable_check_due_at absente après les vraies migrations ») ;
//   - le `WHERE ... IS NOT NULL` retiré du CREATE INDEX de la migration → le
//     troisième test rougit (l'index n'est plus partiel).

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

describe('migration 0118_agent_jobs_deliverable_check_due @cap:verifier-un-livrable/moteur', () => {
  it('démarre un vrai Postgres et applique les VRAIES migrations', async () => {
    pg = await startRealPostgres();
    expect(pg.url).toMatch(/^postgresql:\/\//);
    await runMigrations(pg.url, { patchVectorAsText: true });
  }, 120_000);

  it('deliverable_check_due_at existe, horodatée, NULLABLE et sans défaut', async () => {
    const { db, close } = createClient(harness().url, { max: 1 });
    try {
      const colonnes = (await db.execute(
        sql`SELECT column_name, data_type, is_nullable, column_default
            FROM information_schema.columns
            WHERE table_schema = 'public'
              AND table_name = 'agent_jobs'
              AND column_name = 'deliverable_check_due_at'`,
      )) as unknown as Array<{
        column_name: string;
        data_type: string;
        is_nullable: string;
        column_default: string | null;
      }>;

      expect(colonnes, 'deliverable_check_due_at absente après les vraies migrations').toHaveLength(
        1,
      );
      const colonne = colonnes[0]!;
      expect(colonne.data_type).toBe('timestamp with time zone');
      // NULLABLE et SANS DÉFAUT : un run d'avant cette colonne n'a pas livré
      // sous les yeux de personne, et NULL veut dire « rien n'attend » plutôt
      // que « on ne sait pas ».
      expect(colonne.is_nullable).toBe('YES');
      expect(colonne.column_default).toBeNull();
    } finally {
      await close();
    }
  });

  it('l’index qui sert la pastille existe, et il est PARTIEL', async () => {
    const { db, close } = createClient(harness().url, { max: 1 });
    try {
      const index = (await db.execute(
        sql`SELECT indexdef
            FROM pg_indexes
            WHERE schemaname = 'public'
              AND tablename = 'agent_jobs'
              AND indexname = 'idx_agent_jobs_deliverable_check_due'`,
      )) as unknown as Array<{ indexdef: string }>;

      expect(index, 'idx_agent_jobs_deliverable_check_due absent').toHaveLength(1);
      const definition = index[0]!.indexdef;
      // Sur l'espace : la pastille demande « ce qui attend dans CET espace ».
      expect(definition).toContain('(entity_id)');
      // PARTIEL : sans ce prédicat, l'index porterait une entrée par job de la
      // table, quand la pastille ne regarde que ce qui n'a pas été vu.
      expect(definition, 'l’index n’est pas partiel').toContain(
        'WHERE (deliverable_check_due_at IS NOT NULL)',
      );
    } finally {
      await close();
    }
  });

  it('le fait se pose, se relit, et se relâche quand la personne a regardé', async () => {
    const { db, close } = createClient(harness().url, { max: 1 });
    try {
      const [u] = await db
        .insert(users)
        .values({ email: 'livrable@exemple.test' })
        .returning({ id: users.id });
      const [e] = await db
        .insert(entities)
        .values({ userId: u!.id, name: 'Livrable', slug: 'livrable' })
        .returning({ id: entities.id });
      const [a] = await db
        .insert(agents)
        .values({ entityId: e!.id, name: 'Agent', slug: 'agent-livrable', personality: '' })
        .returning({ id: agents.id });

      const pose = new Date(Date.UTC(2026, 8, 20, 14, 30, 0));
      const [job] = await db
        .insert(agentJobs)
        .values({
          entityId: e!.id,
          agentId: a!.id,
          channel: 'dashboard',
          task: 'écrire le rapport',
          deliverableCheckDueAt: pose,
        })
        .returning({ id: agentJobs.id });

      const lu = async (): Promise<Date | null> => {
        const [row] = await db
          .select({ due: agentJobs.deliverableCheckDueAt })
          .from(agentJobs)
          .where(eq(agentJobs.id, job!.id));
        return row!.due ?? null;
      };

      expect(await lu(), 'le fait posé ne se relit pas').toEqual(pose);

      // Ce que fait le web quand la personne ouvre le run ou son fil.
      await db
        .update(agentJobs)
        .set({ deliverableCheckDueAt: null })
        .where(eq(agentJobs.id, job!.id));
      expect(
        await lu(),
        'le fait ne se relâche pas : la pastille ne s’éteindrait jamais',
      ).toBeNull();
    } finally {
      await close();
    }
  });
});
