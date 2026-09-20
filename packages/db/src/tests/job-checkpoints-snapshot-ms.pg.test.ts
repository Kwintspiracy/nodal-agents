// job-checkpoints-snapshot-ms.pg.test.ts — migration 0119 contre un VRAI
// Postgres (#261).
//
// @cap:travailler-sur-des-fichiers/moteur
//
// POURQUOI UN FICHIER À PART. `pnpm test` construit sa base depuis le SQL en
// ligne de `helpers.ts`, jamais depuis `migrations/`. Une migration peut donc
// être fausse — ou, pire, absente de `meta/_journal.json`, ce qui la fait
// ignorer EN SILENCE par drizzle-kit — pendant que toute la suite reste verte,
// et seule une vraie mise à jour casse.
//
// Ce que ce fichier prouve :
//
//   1. la colonne `snapshot_ms` existe APRÈS les vraies migrations, entière,
//      NULLABLE et SANS DÉFAUT — une ligne d'avant la colonne n'a pas été
//      chronométrée et ne reçoit pas une durée inventée ;
//   2. une durée NÉGATIVE est refusée : c'est un constat d'horloge, et un
//      nombre négatif ne dirait rien qu'un écran puisse rendre ;
//   3. zéro est ACCEPTÉ, et ce n'est pas la même chose que NULL. Une photo peut
//      légitimement tomber sous la milliseconde ; c'est l'écran qui distingue
//      « instantanée » de « pas mesurée » ;
//   4. l'index qui sert « la dernière photo de cet espace » existe, et il est
//      DÉCROISSANT — c'est ce sens-là qui rend la ligne la plus récente en une
//      sonde, y compris pour un espace silencieux.
//
// Mutations vérifiées :
//   - l'entrée 119 retirée de `meta/_journal.json` → le deuxième test rougit
//     (« snapshot_ms absente après les vraies migrations ») ;
//   - la contrainte retirée de la migration → le quatrième test rougit (une
//     durée négative s'écrit au lieu d'être refusée) ;
//   - le `DESC` retiré du CREATE INDEX → le troisième test rougit.

import { describe, it, expect, afterAll } from 'vitest';
import { startRealPostgres, type RealPostgres } from '@nodal-agents/test-kit';
import {
  createClient,
  sql,
  eq,
  agentJobs,
  agents,
  entities,
  jobCheckpoints,
  users,
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

/** Semé par le troisième test, relu par les suivants. */
const seme = { jobId: '' };

describe('migration 0119_job_checkpoints_snapshot_ms @cap:travailler-sur-des-fichiers/moteur', () => {
  it('démarre un vrai Postgres et applique les VRAIES migrations', async () => {
    pg = await startRealPostgres();
    expect(pg.url).toMatch(/^postgresql:\/\//);
    await runMigrations(pg.url, { patchVectorAsText: true });
  }, 120_000);

  it('snapshot_ms existe, entière, NULLABLE et sans défaut', async () => {
    const { db, close } = createClient(harness().url, { max: 1 });
    try {
      const colonnes = (await db.execute(
        sql`SELECT column_name, data_type, is_nullable, column_default
            FROM information_schema.columns
            WHERE table_schema = 'public'
              AND table_name = 'job_checkpoints'
              AND column_name = 'snapshot_ms'`,
      )) as unknown as Array<{
        column_name: string;
        data_type: string;
        is_nullable: string;
        column_default: string | null;
      }>;

      expect(colonnes, 'snapshot_ms absente après les vraies migrations').toHaveLength(1);
      const colonne = colonnes[0]!;
      expect(colonne.data_type).toBe('integer');
      // NULLABLE et SANS DÉFAUT : une photo d'avant la colonne n'a pas été
      // chronométrée, et NULL dit « pas mesurée » là où zéro dirait
      // « instantanée ».
      expect(colonne.is_nullable).toBe('YES');
      expect(colonne.column_default).toBeNull();
    } finally {
      await close();
    }
  });

  it('l’index qui sert « la dernière photo de cet espace » existe, en DESC', async () => {
    const { db, close } = createClient(harness().url, { max: 1 });
    try {
      const index = (await db.execute(
        sql`SELECT indexdef
            FROM pg_indexes
            WHERE schemaname = 'public'
              AND tablename = 'job_checkpoints'
              AND indexname = 'idx_job_checkpoints_taken_at'`,
      )) as unknown as Array<{ indexdef: string }>;

      expect(index, 'idx_job_checkpoints_taken_at absent').toHaveLength(1);
      // DESC, et pas l'ordre par défaut : la lecture demande la ligne la plus
      // RÉCENTE d'un espace, et c'est ce sens-là qui la sert en une sonde.
      expect(index[0]!.indexdef, 'l’index n’est pas décroissant').toContain('taken_at DESC');
    } finally {
      await close();
    }
  });

  it('une durée négative est REFUSÉE ; zéro et NULL passent, et diffèrent', async () => {
    const { db, close } = createClient(harness().url, { max: 1 });
    try {
      const [u] = await db
        .insert(users)
        .values({ email: 'photo@exemple.test' })
        .returning({ id: users.id });
      const [e] = await db
        .insert(entities)
        .values({ userId: u!.id, name: 'Photo', slug: 'photo' })
        .returning({ id: entities.id });
      const [a] = await db
        .insert(agents)
        .values({ entityId: e!.id, name: 'Agent', slug: 'agent-photo', personality: '' })
        .returning({ id: agents.id });
      const [job] = await db
        .insert(agentJobs)
        .values({
          entityId: e!.id,
          agentId: a!.id,
          channel: 'dashboard',
          task: 'écrire un fichier',
        })
        .returning({ id: agentJobs.id });
      seme.jobId = job!.id;

      const poser = async (turn: number, snapshotMs: number | null): Promise<number | null> => {
        const [row] = await db
          .insert(jobCheckpoints)
          .values({
            jobId: seme.jobId,
            turn,
            workspace: `C:/travail/${turn}`,
            sha: 'abcdef0',
            ...(snapshotMs === null ? {} : { snapshotMs }),
          })
          .returning({ id: jobCheckpoints.id });
        const [relu] = await db
          .select({ ms: jobCheckpoints.snapshotMs })
          .from(jobCheckpoints)
          .where(eq(jobCheckpoints.id, row!.id));
        return relu!.ms ?? null;
      };

      expect(await poser(1, 24_130)).toBe(24_130);
      // Zéro s'écrit : une photo peut tomber sous la milliseconde, et c'est un
      // fait, pas une absence.
      expect(await poser(2, 0)).toBe(0);
      expect(await poser(3, null), 'une ligne sans mesure en a reçu une').toBeNull();

      let refus: unknown = null;
      try {
        await db.execute(
          sql`INSERT INTO job_checkpoints (job_id, turn, workspace, sha, snapshot_ms)
              VALUES (${seme.jobId}, 4, 'C:/travail/4', 'abcdef0', -1)`,
        );
      } catch (err) {
        refus = err;
      }
      expect(refus, 'une durée négative a été acceptée').not.toBeNull();

      // La CONTRAINTE nommée, pas un refus quelconque : un test qui se
      // contenterait d'un rejet passerait aussi sur une colonne manquante.
      const noms: string[] = [];
      for (let e2: unknown = refus; e2 !== null && e2 !== undefined; ) {
        const o = e2 as { message?: unknown; constraint_name?: unknown; cause?: unknown };
        if (typeof o.message === 'string') noms.push(o.message);
        if (typeof o.constraint_name === 'string') noms.push(o.constraint_name);
        e2 = o.cause ?? null;
      }
      expect(noms.join(' | ')).toContain('job_checkpoints_snapshot_ms_check');
    } finally {
      await close();
    }
  });
});
