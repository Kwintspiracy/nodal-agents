// entities-proof-repair-attempts.pg.test.ts — migration 0121 contre un VRAI
// Postgres.
//
// @cap:verifier-un-livrable/moteur
//
// POURQUOI UN FICHIER À PART. `pnpm test` construit sa base depuis le SQL
// inline de `helpers.ts`, jamais depuis `migrations/`. Une migration peut donc
// être fausse — ou absente de `meta/_journal.json`, ce qui fait que drizzle-kit
// l'ignore EN SILENCE — pendant que toute la suite reste verte, et seule une
// vraie mise à jour casse.
//
// CE QUE CELA PROUVE EN PLUS DE L'EXISTENCE DE LA COLONNE. Le CHECK. Cette
// colonne borne une boucle du runner (invariant #8) : `finalize` rouvre un run
// autant de fois qu'elle le dit. Un formulaire qui valide 0 à 3 ne protège que
// ce qui passe par lui ; un script, une main sur `psql` ou une future action
// oubliée écriraient 9 999 sans que rien ne les arrête. Le test écrit donc les
// quatre valeurs légitimes et les deux qui ne le sont pas.
//
// Le démarrage est un TEST, pas un `beforeAll` : un `beforeAll` qui lève marque
// les tests « sautés », et un test sauté en silence est un faux vert (inv. #4).

import { describe, it, expect, afterAll } from 'vitest';
import { startRealPostgres, type RealPostgres } from '@nodal-agents/test-kit';
import { createClient, sql } from '@nodal-agents/db';
import { runMigrations } from '@nodal-agents/db/migrate';
import { PROOF_REPAIR_ATTEMPTS_CHOICES } from '@nodal-agents/shared';

let pg: RealPostgres | null = null;

afterAll(async () => {
  await pg?.stop();
});

function harness(): RealPostgres {
  if (!pg) expect.fail('REAL_POSTGRES_NOT_STARTED — the startup test failed before this one');
  return pg;
}

/** Un espace jetable, avec son utilisateur — la FK exige les deux. */
async function espace(db: ReturnType<typeof createClient>['db'], slug: string): Promise<string> {
  const users = (await db.execute(
    sql`INSERT INTO users (email) VALUES (${`${slug}@example.com`}) RETURNING id`,
  )) as unknown as Array<{ id: string }>;
  const rows = (await db.execute(
    sql`INSERT INTO entities (user_id, name, slug)
        VALUES (${users[0]!.id}, ${slug}, ${slug}) RETURNING id`,
  )) as unknown as Array<{ id: string }>;
  return rows[0]!.id;
}

describe('migration 0121_entities_proof_repair_attempts @cap:verifier-un-livrable/moteur', () => {
  it('starts a real Postgres and applies the REAL migrations — red if the binary is missing, not skipped', async () => {
    pg = await startRealPostgres();
    expect(pg.url).toMatch(/^postgresql:\/\//);
    await runMigrations(pg.url, { patchVectorAsText: true });
  }, 120_000);

  it('la colonne est un entier requis, et son défaut est UN tour — ce que #375 fait déjà', async () => {
    const { db, close } = createClient(harness().url, { max: 1 });
    try {
      const rows = (await db.execute(
        sql`SELECT data_type, is_nullable, column_default
            FROM information_schema.columns
            WHERE table_schema = 'public'
              AND table_name = 'entities'
              AND column_name = 'proof_repair_attempts'`,
      )) as unknown as Array<{ data_type: string; is_nullable: string; column_default: string }>;

      expect(rows).toHaveLength(1);
      expect(rows[0]!.data_type).toBe('integer');
      expect(rows[0]!.is_nullable).toBe('NO');
      // Le défaut est la borne d'avant : une migration ne change le
      // comportement de personne.
      expect(rows[0]!.column_default).toContain('1');

      // Et un espace créé sans rien dire le porte.
      const id = await espace(db, `repair-defaut-${Date.now()}`);
      const lu = (await db.execute(
        sql`SELECT proof_repair_attempts AS n FROM entities WHERE id = ${id}`,
      )) as unknown as Array<{ n: number }>;
      expect(lu[0]!.n).toBe(1);
    } finally {
      await close();
    }
  });

  it('accepte les quatre valeurs offertes, et REFUSE tout ce qui est en dehors', async () => {
    const { db, close } = createClient(harness().url, { max: 1 });
    try {
      const id = await espace(db, `repair-bornes-${Date.now()}`);

      for (const n of PROOF_REPAIR_ATTEMPTS_CHOICES) {
        await db.execute(sql`UPDATE entities SET proof_repair_attempts = ${n} WHERE id = ${id}`);
        const lu = (await db.execute(
          sql`SELECT proof_repair_attempts AS n FROM entities WHERE id = ${id}`,
        )) as unknown as Array<{ n: number }>;
        expect(lu[0]!.n).toBe(n);
      }

      // Sous la borne : une réparation négative ne veut rien dire.
      await expect(
        db.execute(sql`UPDATE entities SET proof_repair_attempts = -1 WHERE id = ${id}`),
      ).rejects.toThrow();
      // Au-dessus : c'est la garde anti-boucle qui saute, et c'est tout
      // l'intérêt d'un CHECK plutôt que d'une validation de formulaire.
      await expect(
        db.execute(sql`UPDATE entities SET proof_repair_attempts = 4 WHERE id = ${id}`),
      ).rejects.toThrow();
      await expect(
        db.execute(sql`UPDATE entities SET proof_repair_attempts = 9999 WHERE id = ${id}`),
      ).rejects.toThrow();

      // La dernière valeur ACCEPTÉE est restée : un refus n'écrit rien.
      const apres = (await db.execute(
        sql`SELECT proof_repair_attempts AS n FROM entities WHERE id = ${id}`,
      )) as unknown as Array<{ n: number }>;
      expect(apres[0]!.n).toBe(PROOF_REPAIR_ATTEMPTS_CHOICES.at(-1));
    } finally {
      await close();
    }
  });

  it('records the migration in the journal drizzle-kit actually reads', async () => {
    const journal = (await import('../../migrations/meta/_journal.json', {
      with: { type: 'json' },
    })) as { default: { entries: Array<{ idx: number; tag: string }> } };
    const tags = journal.default.entries.map((e) => e.tag);
    expect(tags).toContain('0121_entities_proof_repair_attempts');
  });
});
