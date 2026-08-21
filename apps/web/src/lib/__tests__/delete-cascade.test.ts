// delete-cascade.test.ts — la question qui prime sur les 33 actions restantes.
//
// Observation qui a motivé ce fichier : après la suite des espaces de travail,
// la ligne du workspace de test n'était plus dans `entities`, alors qu'aucun
// test ne l'avait supprimée. Deux explications, très inégales :
//
//   - artefact de test (base partagée, ordre malheureux) ;
//   - ou `deleteWorkspaceAction` emporte plus que sa cible — auquel cas c'est un
//     défaut produit qui fait perdre des espaces à des utilisateurs.
//
// RÉPONSE : la première. Ce test passe — une seule ligne disparaît, le voisin et
// l'espace de la session restent intacts. Le produit va bien ; c'était la base
// de test partagée entre suites. Conservé comme régression : une cascade trop
// large ajoutée plus tard ferait perdre des espaces sans que rien ne le dise.

import { describe, it, expect, beforeAll, vi } from 'vitest';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import { eq, and, entities, entityMembers } from '@nodal-agents/db';

let testDb: TestDb;
let seed: Awaited<ReturnType<typeof seedMinimal>>;

vi.mock('@/lib/server.ts', () => ({
  getDb: () => testDb,
  getAuthProvider: () => ({ name: 'local-trust' }),
  ACTIVE_ENTITY_COOKIE: 'nodalai_active_entity',
  applyActiveEntity: (session: { userId: string; entityId?: string }) => ({
    ...session,
    entityId: seed?.entityId ?? session.entityId ?? '',
  }),
}));

vi.mock('next/headers', () => ({
  headers: async () => new Headers(),
  cookies: async () => ({ set: () => {}, get: () => null, delete: () => {} }),
}));

vi.mock('next/cache', () => ({ revalidatePath: () => {} }));

vi.mock('@nodal-agents/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@nodal-agents/auth')>();
  return {
    ...actual,
    requireAuth: async () => ({
      userId: seed?.userId ?? 'mock-user-id',
      entityId: seed?.entityId ?? 'mock-entity-id',
    }),
  };
});

beforeAll(async () => {
  const result = await spinUpTestDb();
  testDb = result.db;
  seed = await seedMinimal(testDb);
  // seedMinimal ne crée pas forcément la ligne d'appartenance ; les gardes de
  // suppression la lisent, donc on s'assure qu'elle existe.
  const existing = await testDb
    .select()
    .from(entityMembers)
    .where(and(eq(entityMembers.entityId, seed.entityId), eq(entityMembers.userId, seed.userId)));
  if (existing.length === 0) {
    await testDb
      .insert(entityMembers)
      .values({ entityId: seed.entityId, userId: seed.userId, role: 'owner' });
  }
});

async function actions() {
  return import('../actions.ts');
}

describe('deleteWorkspaceAction — périmètre de la suppression', () => {
  it('ne supprime QUE l’espace visé', async () => {
    const { createWorkspaceAction, deleteWorkspaceAction } = await actions();

    const a = await createWorkspaceAction({ name: 'Cible' });
    const b = await createWorkspaceAction({ name: 'Voisin' });
    const idA = a.ok ? a.data.id : '';
    const idB = b.ok ? b.data.id : '';

    const before = await testDb.select().from(entities);
    const r = await deleteWorkspaceAction({ id: idA });
    expect(r.ok, r.ok ? '' : r.message).toBe(true);
    const after = await testDb.select().from(entities);

    // UNE ligne de moins, pas deux, pas trois.
    expect(after.length).toBe(before.length - 1);
    // La cible est partie…
    expect(after.find((e) => e.id === idA)).toBeUndefined();
    // …et le voisin comme l’espace de la session sont intacts.
    expect(
      after.find((e) => e.id === idB),
      'le voisin a été emporté',
    ).toBeDefined();
    expect(
      after.find((e) => e.id === seed.entityId),
      'la session a été emportée',
    ).toBeDefined();
  });
});
