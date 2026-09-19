// job-failure-hint.pg.test.ts — migration 0116 contre un VRAI Postgres.
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
// colonne `agent_jobs.failure_hint` existe APRÈS les vraies migrations, elle
// accepte NULL (le cas de la grande majorité des échecs), et le RATTRAPAGE
// écrit dans la même migration touche exactement les lignes qu'il doit
// toucher — celles dont le code d'erreur est le refus de fournisseur, et
// aucune autre.
//
// Mutation vérifiée : l'entrée 116 retirée de `meta/_journal.json` → le second
// test rougit (« failure_hint absente après les vraies migrations »).

import { describe, it, expect, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { startRealPostgres, type RealPostgres } from '@nodal-agents/test-kit';
import { createClient, sql, agents, entities, users } from '@nodal-agents/db';
import { runMigrations } from '@nodal-agents/db/migrate';

let pg: RealPostgres | null = null;

afterAll(async () => {
  await pg?.stop();
});

function harness(): RealPostgres {
  if (!pg) expect.fail('REAL_POSTGRES_NOT_STARTED — the startup test failed before this one');
  return pg;
}

/** Le fichier de migration LUI-MÊME, pour rejouer son rattrapage. */
const MIGRATION_0116 = fileURLToPath(
  new URL('../../migrations/0116_job_failure_hint.sql', import.meta.url),
);

/** Les identités semées par le troisième test, relues par les suivants. */
const seme = { userId: '', entityId: '', agentId: '' };

describe('migration 0116_job_failure_hint @cap:suivre-execution/moteur', () => {
  it('démarre un vrai Postgres et applique les VRAIES migrations', async () => {
    pg = await startRealPostgres();
    expect(pg.url).toMatch(/^postgresql:\/\//);
    await runMigrations(pg.url, { patchVectorAsText: true });
  }, 120_000);

  it('agent_jobs.failure_hint existe, en texte et nullable', async () => {
    const { db, close } = createClient(harness().url, { max: 1 });
    try {
      const colonnes = (await db.execute(
        sql`SELECT data_type, is_nullable
            FROM information_schema.columns
            WHERE table_schema = 'public'
              AND table_name = 'agent_jobs'
              AND column_name = 'failure_hint'`,
      )) as unknown as Array<{ data_type: string; is_nullable: string }>;

      expect(colonnes, 'failure_hint absente après les vraies migrations').toHaveLength(1);
      expect(colonnes[0]!.data_type).toBe('text');
      // Nullable, et c'est le cas NORMAL : la grande majorité des échecs
      // n'appellent aucun geste nommable.
      expect(colonnes[0]!.is_nullable).toBe('YES');
    } finally {
      await close();
    }
  });

  it('aucune contrainte ne borne les valeurs — un geste inconnu de l’écran s’écrit quand même', async () => {
    const { db, close } = createClient(harness().url, { max: 1 });
    try {
      const [u] = await db
        .insert(users)
        .values({ email: 'geste@exemple.test' })
        .returning({ id: users.id });
      seme.userId = u!.id;
      const [e] = await db
        .insert(entities)
        .values({ userId: seme.userId, name: 'Gestes', slug: 'gestes' })
        .returning({ id: entities.id });
      seme.entityId = e!.id;
      const [a] = await db
        .insert(agents)
        .values({ entityId: seme.entityId, name: 'Agent', slug: 'agent-geste', personality: '' })
        .returning({ id: agents.id });
      seme.agentId = a!.id;

      // Un runner plus récent que cet écran doit pouvoir écrire son mot : un
      // CHECK ferait échouer l'écriture de l'échec, donc perdrait le job, pour
      // un geste que l'écran savait déjà taire (invariant #4).
      await db.execute(sql`
        INSERT INTO agent_jobs (entity_id, agent_id, channel, task, status, error, failure_hint)
        VALUES (${seme.entityId}::uuid, ${seme.agentId}::uuid, 'api', 'tâche', 'failed',
                'quota_exhausted', 'rotate_api_key')`);

      const lignes = (await db.execute(
        sql`SELECT failure_hint FROM agent_jobs WHERE error = 'quota_exhausted'`,
      )) as unknown as Array<{ failure_hint: string | null }>;
      expect(lignes[0]!.failure_hint).toBe('rotate_api_key');
    } finally {
      await close();
    }
  });

  it('le rattrapage de la migration touche les refus de fournisseur, et EUX SEULS', async () => {
    const { db, close } = createClient(harness().url, { max: 1 });
    try {
      // Trois lignes « d'avant la migration » : geste vide, codes différents.
      // La troisième est le voisin de nom qui ne doit PAS être rattrapé — sans
      // les deux-points, `provider_rejected_request_upstream` n'est pas ce
      // refus-là, et l'écran enverrait changer un réglage qui n'y est pour rien.
      const cas: Array<[string, string | null]> = [
        ['provider_rejected_request:openrouter/google/gemini-3.7-flash (http 400, turn 3)', null],
        ['delivery_spam_guard', null],
        ['provider_rejected_request_upstream:openrouter/x (http 500, turn 1)', null],
      ];
      for (const [code] of cas) {
        await db.execute(sql`
          INSERT INTO agent_jobs (entity_id, agent_id, channel, task, status, error, failure_hint)
          VALUES (${seme.entityId}::uuid, ${seme.agentId}::uuid, 'api', 'legacy', 'failed',
                  ${code}, NULL)`);
      }
      // Et une ligne encore en cours, qui porte le code sans être morte : le
      // rattrapage est borné à `status = 'failed'`.
      await db.execute(sql`
        INSERT INTO agent_jobs (entity_id, agent_id, channel, task, status, error, failure_hint)
        VALUES (${seme.entityId}::uuid, ${seme.agentId}::uuid, 'api', 'en cours', 'processing',
                'provider_rejected_request:openrouter/x (http 400, turn 1)', NULL)`);

      // Le rattrapage REJOUÉ depuis le fichier de migration lui-même — pas une
      // copie de son SQL, qui pourrait dire autre chose que ce qui s'exécute.
      const fichier = readFileSync(MIGRATION_0116, 'utf8');
      for (const instruction of fichier.split('--> statement-breakpoint')) {
        if (instruction.trim() === '') continue;
        await db.execute(sql.raw(instruction));
      }

      const lignes = (await db.execute(
        sql`SELECT error, status, failure_hint FROM agent_jobs
            WHERE task IN ('legacy', 'en cours')
            ORDER BY error`,
      )) as unknown as Array<{ error: string; status: string; failure_hint: string | null }>;

      const parCode = new Map(lignes.map((l) => [`${l.error}|${l.status}`, l.failure_hint]));
      expect(
        parCode.get(
          'provider_rejected_request:openrouter/google/gemini-3.7-flash (http 400, turn 3)|failed',
        ),
        'le refus de fournisseur n’a pas été rattrapé',
      ).toBe('switch_model');
      expect(parCode.get('delivery_spam_guard|failed')).toBeNull();
      expect(
        parCode.get('provider_rejected_request_upstream:openrouter/x (http 500, turn 1)|failed'),
        'un voisin de nom a été pris pour ce refus-là',
      ).toBeNull();
      expect(
        parCode.get('provider_rejected_request:openrouter/x (http 400, turn 1)|processing'),
        'un job encore en vie a été rattrapé',
      ).toBeNull();
    } finally {
      await close();
    }
  });
});
