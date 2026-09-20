// migration-gap-repair.pg.test.ts — la réparation d'un trou, contre un VRAI
// Postgres (#298).
//
// @cap:installer-et-demarrer/moteur
//
// POURQUOI UN FICHIER À PART. `pnpm test` construit sa base depuis le SQL en
// ligne de `helpers.ts`, jamais depuis `migrations/`. Rien là-dedans ne passe
// par la table d'historique de drizzle, donc rien n'y prouve qu'une migration
// sautée soit vue, encore moins reposée. Seul un vrai Postgres, avec les
// VRAIES migrations et la vraie table `drizzle.__drizzle_migrations`, le dit.
//
// Le scénario est celui du 20/09/2026, rejoué : on applique tout, puis on
// DÉFAIT 0114 comme le migrateur l'avait laissée — la ligne d'historique
// retirée et les deux colonnes absentes — et on demande à la réparation de la
// reposer. C'est l'état exact de la base du propriétaire ce jour-là.
//
// Mutation vérifiée : l'insertion de la ligne d'historique retirée de
// `repairMigrations` → le dernier cas rougit, le trou revient à la lecture
// suivante et `up` refuserait de servir pour toujours.

import { describe, it, expect, afterAll } from 'vitest';
import { startRealPostgres, type RealPostgres } from '@nodal-agents/test-kit';
import { createClient, sql } from '@nodal-agents/db';
import { runMigrations, findMigrationGaps, repairMigrations } from '@nodal-agents/db/migrate';

let pg: RealPostgres | null = null;

afterAll(async () => {
  await pg?.stop();
});

function harness(): RealPostgres {
  if (!pg) expect.fail('REAL_POSTGRES_NOT_STARTED — the startup test failed before this one');
  return pg;
}

/** Le `when` de 0114, tel que `meta/_journal.json` le porte. */
const QUAND_0114 = 1_786_000_920_000;
const TAG_0114 = '0114_code_projects_init_git';

/** Les colonnes que 0114 pose, et dont l'absence a cassé « Remove from list ». */
async function colonnesDe0114(url: string): Promise<string[]> {
  const { db, close } = createClient(url, { max: 1 });
  try {
    const r = await db.execute(sql`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'code_projects'
        AND column_name IN ('init_git', 'git_initialized_at')
      ORDER BY column_name`);
    return (r as unknown as { column_name: string }[]).map((l) => l.column_name);
  } finally {
    await close();
  }
}

describe('réparer une migration sautée @cap:installer-et-demarrer/moteur', () => {
  it('démarre un vrai Postgres et applique les VRAIES migrations', async () => {
    // Le démarrage est un TEST, pas un `beforeAll` : un `beforeAll` qui lève
    // marque les cas « sautés », et un test sauté en silence est un vert par
    // absence (invariant #4).
    pg = await startRealPostgres();
    expect(pg.url).toMatch(/^postgresql:\/\//);
    // Pas de pgvector dans le Postgres embarqué : les colonnes `vector(N)`
    // sont réécrites en `text`, exactement comme le fait `nodal-agents up` sur
    // une machine sans l'extension. C'est AUSSI le cas qui rendrait un
    // contrôle par hash faux, puisque les fichiers appliqués sont alors
    // différents de ceux du dépôt.
    await runMigrations(pg.url, { patchVectorAsText: true });
  }, 120_000);

  it('ne voit AUCUN trou sur une base qui vient d’être migrée', async () => {
    const trous = await findMigrationGaps(harness().url, { patchVectorAsText: true });
    expect(trous).toEqual([]);
  });

  it('VOIT le trou quand 0114 a été sautée, et la nomme', async () => {
    // On défait 0114 comme le migrateur l'avait laissée le 20/09 : sa ligne
    // d'historique n'existe pas, et ses colonnes non plus.
    const { db, close } = createClient(harness().url, { max: 1 });
    try {
      await db.execute(
        sql`DELETE FROM drizzle.__drizzle_migrations WHERE created_at = ${QUAND_0114}`,
      );
      await db.execute(sql`ALTER TABLE code_projects DROP COLUMN IF EXISTS init_git`);
      await db.execute(sql`ALTER TABLE code_projects DROP COLUMN IF EXISTS git_initialized_at`);
    } finally {
      await close();
    }
    expect(await colonnesDe0114(harness().url)).toEqual([]);

    const trous = await findMigrationGaps(harness().url, { patchVectorAsText: true });
    expect(trous).toEqual([{ idx: 114, tag: TAG_0114, when: QUAND_0114 }]);
  });

  it('`runMigrations` NE LA RATTRAPE PAS — c’est tout le sujet', async () => {
    // Relancer le migrateur ne répare rien : il ne regarde que la dernière
    // ligne d'historique, et 0117 y est encore. Sans ce cas, on pourrait
    // croire qu'un simple redémarrage suffit.
    await runMigrations(harness().url, { patchVectorAsText: true });
    expect(await colonnesDe0114(harness().url)).toEqual([]);
    const trous = await findMigrationGaps(harness().url, { patchVectorAsText: true });
    expect(trous.map((t) => t.tag)).toEqual([TAG_0114]);
  }, 60_000);

  it('la réparation repose les colonnes ET la ligne d’historique', async () => {
    const reparees = await repairMigrations(harness().url, { patchVectorAsText: true });
    expect(reparees.map((t) => t.tag)).toEqual([TAG_0114]);

    // Le FAIT : les deux colonnes sont là, celles dont l'absence faisait
    // échouer « Remove from list ».
    expect(await colonnesDe0114(harness().url)).toEqual(['git_initialized_at', 'init_git']);

    // Et la ligne d'historique aussi, au format de drizzle : `created_at` =
    // le `when` du journal, `hash` = un sha256 en 64 caractères.
    const { db, close } = createClient(harness().url, { max: 1 });
    try {
      const r = await db.execute(sql`
        SELECT hash, created_at FROM drizzle.__drizzle_migrations
        WHERE created_at = ${QUAND_0114}`);
      const lignes = r as unknown as { hash: string; created_at: string | number }[];
      expect(lignes).toHaveLength(1);
      expect(Number(lignes[0]?.created_at)).toBe(QUAND_0114);
      expect(lignes[0]?.hash).toMatch(/^[0-9a-f]{64}$/);
    } finally {
      await close();
    }

    // Et le contrôle ne trouve plus rien : c'est ce que `up` relit avant de
    // décider s'il sert.
    expect(await findMigrationGaps(harness().url, { patchVectorAsText: true })).toEqual([]);
  }, 60_000);

  it('réparer une base SANS trou ne fait rien', async () => {
    expect(await repairMigrations(harness().url, { patchVectorAsText: true })).toEqual([]);
  });
});
