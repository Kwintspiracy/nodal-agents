// deliverable-declared-migration.pg.test.ts — migration 0129 contre un VRAI
// Postgres (#509).
//
// POURQUOI UN FICHIER À PART. `pnpm test` construit sa base depuis le SQL en
// ligne de `helpers.ts`, jamais depuis `migrations/` : une migration absente du
// journal serait ignorée EN SILENCE, suite verte. Ce fichier applique les
// VRAIES migrations et lit la colonne.
//
// Ce qu'il prouve :
//   1. `declared` existe après les vraies migrations, booléen, NOT NULL, défaut
//      `false` — une ligne écrite avant la colonne n'a été promise par personne ;
//   2. une ligne insérée sans la nommer vaut `false`, et une ligne DÉCLARÉE se
//      relit `true`.

import { describe, it, expect, afterAll } from 'vitest';
import { startRealPostgres, type RealPostgres } from '@nodal-agents/test-kit';
import {
  createClient,
  sql,
  eq,
  agentJobs,
  agents,
  entities,
  users,
  jobDeliverableVerificationState,
} from '@nodal-agents/db';
import { runMigrations } from '@nodal-agents/db/migrate';

let pg: RealPostgres | null = null;

afterAll(async () => {
  await pg?.stop();
});

function harness(): RealPostgres {
  if (!pg) expect.fail('REAL_POSTGRES_NOT_STARTED — the startup test failed before this one');
  return pg;
}

describe('migration 0129_deliverable_declared @cap:verifier-un-livrable/moteur', () => {
  it('démarre un vrai Postgres et applique les VRAIES migrations', async () => {
    pg = await startRealPostgres();
    expect(pg.url).toMatch(/^postgresql:\/\//);
    await runMigrations(pg.url, { patchVectorAsText: true });
  }, 120_000);

  it('declared existe : booléen, NOT NULL, défaut false', async () => {
    const { db, close } = createClient(harness().url, { max: 1 });
    try {
      const colonnes = (await db.execute(
        sql`SELECT data_type, is_nullable, column_default
            FROM information_schema.columns
            WHERE table_schema = 'public'
              AND table_name = 'job_deliverable_verification_state'
              AND column_name = 'declared'`,
      )) as unknown as Array<{
        data_type: string;
        is_nullable: string;
        column_default: string | null;
      }>;
      expect(colonnes, 'declared absente après les vraies migrations').toHaveLength(1);
      expect(colonnes[0]).toEqual({
        data_type: 'boolean',
        is_nullable: 'NO',
        column_default: 'false',
      });
    } finally {
      await close();
    }
  });

  it('une ligne non nommée vaut false ; une ligne déclarée se relit true', async () => {
    const { db, close } = createClient(harness().url, { max: 1 });
    try {
      const [user] = await db
        .insert(users)
        .values({ email: 'declared@exemple.test' })
        .returning({ id: users.id });
      const [entity] = await db
        .insert(entities)
        .values({ userId: user!.id, name: 'Declared', slug: 'declared' })
        .returning({ id: entities.id });
      const [agent] = await db
        .insert(agents)
        .values({ entityId: entity!.id, name: 'Montage', slug: 'montage', personality: '' })
        .returning({ id: agents.id });
      const [job] = await db
        .insert(agentJobs)
        .values({ entityId: entity!.id, agentId: agent!.id, channel: 'api', task: 'film' })
        .returning({ id: agentJobs.id });

      // Sans nommer la colonne, en SQL brut : ce qu'une ligne d'avant 0129 devient.
      await db.execute(
        sql`INSERT INTO job_deliverable_verification_state
              (job_id, deliverable_type, canonical_key, dirty_generation, decision_status)
            VALUES (${job!.id}, 'document', 'd:/nodal/sources.tsx', 1, 'dirty')`,
      );
      await db.insert(jobDeliverableVerificationState).values({
        jobId: job!.id,
        deliverableType: 'document',
        canonicalKey: 'd:/nodal/film.mp4',
        dirtyGeneration: 1,
        decisionStatus: 'dirty',
        declared: true,
      });

      const lignes = await db
        .select({
          key: jobDeliverableVerificationState.canonicalKey,
          declared: jobDeliverableVerificationState.declared,
        })
        .from(jobDeliverableVerificationState)
        .where(eq(jobDeliverableVerificationState.jobId, job!.id));
      expect(new Map(lignes.map((l) => [l.key, l.declared]))).toEqual(
        new Map([
          ['d:/nodal/sources.tsx', false],
          ['d:/nodal/film.mp4', true],
        ]),
      );
    } finally {
      await close();
    }
  });
});
