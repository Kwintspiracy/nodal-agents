// verification-surfaces-repo.test.ts — getVerificationSurfaces lit la LIGNE
// réelle et lève quand elle manque (T15, D8). Le miroir de test (helpers.ts)
// doit porter la colonne 0091 : retirer `verification_surfaces` du DDL fait
// rougir le premier test (l'insert de l'entité échoue) — c'est voulu, c'est
// ce qui prouve que les trois copies du schéma sont d'accord. Le seed est un
// TEST, pas un beforeAll : un beforeAll qui lève « saute » les suivants au
// lieu de les rougir.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { sql } from 'drizzle-orm';
import { spinUpTestDb, type TestDb } from './helpers.ts';
import { getVerificationSurfaces } from '../repos/verification-surfaces.ts';
import { users, entities } from '../schema/index.ts';
import type { PGlite } from '@electric-sql/pglite';

let db: TestDb;
let pg: PGlite;
let entityId: string | null = null;

beforeAll(async () => {
  ({ db, pg } = await spinUpTestDb());
});

afterAll(async () => {
  await pg.close();
});

function ent(): string {
  if (!entityId) expect.fail('SEED_FAILED — le premier test a échoué');
  return entityId;
}

describe('getVerificationSurfaces', () => {
  it('seed : une entité neuve s’insère avec la colonne 0091 présente dans le DDL de test', async () => {
    const [user] = await db
      .insert(users)
      .values({ email: `surfaces-${Date.now()}@example.com` })
      .returning();
    const [entity] = await db
      .insert(entities)
      .values({ userId: user!.id, name: 'Surfaces', slug: `surfaces-${Date.now()}` })
      .returning();
    entityId = entity!.id;
    expect(entityId).toBeTruthy();
  });

  it('une entité neuve (colonne à {}) ⇒ toutes les surfaces activées', async () => {
    expect(await getVerificationSurfaces(db, ent())).toEqual({
      codeTask: true,
      cliRuntime: true,
      fileOps: true,
      shell: true,
    });
  });

  it('lit la ligne réelle : {"shell":false} en base ⇒ shell false, les autres true', async () => {
    await db.execute(
      sql`UPDATE entities SET verification_surfaces = '{"shell": false}'::jsonb WHERE id = ${ent()}`,
    );
    expect(await getVerificationSurfaces(db, ent())).toEqual({
      codeTask: true,
      cliRuntime: true,
      fileOps: true,
      shell: false,
    });
  });

  it('une valeur malformée en base ne fait pas lever : repli champ par champ', async () => {
    await db.execute(
      sql`UPDATE entities SET verification_surfaces = '{"fileOps": "non", "codeTask": false}'::jsonb WHERE id = ${ent()}`,
    );
    expect(await getVerificationSurfaces(db, ent())).toEqual({
      codeTask: false,
      cliRuntime: true,
      fileOps: true,
      shell: true,
    });
  });

  it('entité inconnue ⇒ lève ENTITY_NOT_FOUND, jamais un objet par défaut', async () => {
    await expect(
      getVerificationSurfaces(db, '00000000-0000-0000-0000-00000000dead'),
    ).rejects.toThrow('ENTITY_NOT_FOUND');
  });
});
