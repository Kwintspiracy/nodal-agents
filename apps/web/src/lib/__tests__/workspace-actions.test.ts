// workspace-actions.test.ts — lot 1 du plan des tests manquants.
//
// Les actions serveur écrivent en base, et c'est la seule surface du produit où
// une régression est à la fois SILENCIEUSE et destructrice. Le précédent est
// net : `setAgentApprovalRuleAction` supprimait la règle au lieu de l'écrire, en
// renvoyant `ok`. Rien n'a échoué ; l'utilisateur l'a découvert après douze
// approbations inutiles.
//
// D'où la règle de ce fichier : on asserte sur les LIGNES produites, jamais sur
// le code de retour. Un test qui vérifie `result.ok` aurait laissé passer ce
// bug-là intégralement.
//
// Priorité aux gardes, pas aux chemins heureux : les trois refus de
// `deleteWorkspaceAction` sont ce qui sépare « supprimer un espace » de
// « perdre son compte ».

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

describe('createWorkspaceAction', () => {
  it('crée l’espace ET la ligne d’appartenance propriétaire', async () => {
    const { createWorkspaceAction } = await actions();

    const r = await createWorkspaceAction({ name: 'Atelier', icon: '🛠️' });
    expect(r.ok).toBe(true);
    const id = r.ok ? r.data.id : '';

    const [row] = await testDb.select().from(entities).where(eq(entities.id, id));
    expect(row?.name).toBe('Atelier');
    expect(row?.icon).toBe('🛠️');
    expect(row?.slug).toBeTruthy();

    // La seconde écriture compte autant que la première : un espace sans
    // appartenance est un espace que son créateur ne peut plus ouvrir.
    const [member] = await testDb
      .select()
      .from(entityMembers)
      .where(and(eq(entityMembers.entityId, id), eq(entityMembers.userId, seed.userId)));
    expect(member?.role).toBe('owner');
  });

  it('refuse un nom vide — et n’écrit rien', async () => {
    const { createWorkspaceAction } = await actions();
    const before = (await testDb.select().from(entities)).length;

    const r = await createWorkspaceAction({ name: '' });
    expect(r.ok).toBe(false);

    expect((await testDb.select().from(entities)).length).toBe(before);
  });
});

describe('renameWorkspaceAction', () => {
  it('renomme l’espace dont on est membre', async () => {
    const { renameWorkspaceAction } = await actions();

    const r = await renameWorkspaceAction({ id: seed.entityId, name: 'Renommé', icon: '📁' });
    expect(r.ok).toBe(true);

    const [row] = await testDb.select().from(entities).where(eq(entities.id, seed.entityId));
    expect(row?.name).toBe('Renommé');
  });

  it('refuse un espace dont on n’est PAS membre, et ne le modifie pas', async () => {
    // Garde IDOR : sans elle, connaître un GUID suffit à renommer l’espace d’un
    // autre. Le test le prouve en lisant la ligne après le refus.
    const { renameWorkspaceAction } = await actions();
    const [foreign] = await testDb
      .insert(entities)
      .values({ userId: seed.userId, name: 'Étranger', slug: `etranger-${Date.now()}` })
      .returning();

    const r = await renameWorkspaceAction({ id: foreign!.id, name: 'Détourné' });
    expect(r.ok).toBe(false);

    const [row] = await testDb.select().from(entities).where(eq(entities.id, foreign!.id));
    expect(row?.name).toBe('Étranger');
  });
});

describe('deleteWorkspaceAction — les trois refus', () => {
  it('refuse de supprimer l’espace COURANT', async () => {
    // Supprimer l’espace où l’on se trouve laisserait la session pendue sur une
    // entité qui n’existe plus.
    const { deleteWorkspaceAction } = await actions();

    const r = await deleteWorkspaceAction({ id: seed.entityId });
    expect(r.ok).toBe(false);

    const rows = await testDb.select().from(entities).where(eq(entities.id, seed.entityId));
    expect(rows).toHaveLength(1);
  });

  it('refuse un identifiant qui n’est pas un GUID', async () => {
    const { deleteWorkspaceAction } = await actions();
    const r = await deleteWorkspaceAction({ id: 'pas-un-guid' });
    expect(r.ok).toBe(false);
  });

  it('supprime un AUTRE espace dont on est propriétaire', async () => {
    const { createWorkspaceAction, deleteWorkspaceAction } = await actions();

    const created = await createWorkspaceAction({ name: 'À supprimer' });
    const id = created.ok ? created.data.id : '';
    expect((await testDb.select().from(entities).where(eq(entities.id, id))).length).toBe(1);

    const r = await deleteWorkspaceAction({ id });
    expect(r.ok, r.ok ? '' : r.message).toBe(true);

    // La ligne a réellement disparu — pas seulement un `ok` renvoyé.
    expect((await testDb.select().from(entities).where(eq(entities.id, id))).length).toBe(0);
  });
});

describe('switchWorkspaceAction', () => {
  it('refuse un espace dont on n’est pas membre', async () => {
    const { switchWorkspaceAction } = await actions();
    const [foreign] = await testDb
      .insert(entities)
      .values({ userId: seed.userId, name: 'Hors périmètre', slug: `hors-${Date.now()}` })
      .returning();

    const r = await switchWorkspaceAction({ id: foreign!.id });
    expect(r.ok).toBe(false);
  });

  it('accepte un espace dont on est membre', async () => {
    const { createWorkspaceAction, switchWorkspaceAction } = await actions();
    const created = await createWorkspaceAction({ name: 'Bascule' });
    const id = created.ok ? created.data.id : '';

    const r = await switchWorkspaceAction({ id });
    expect(r.ok, r.ok ? '' : r.message).toBe(true);
  });
});
