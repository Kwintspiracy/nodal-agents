// connector-rename-action.test.ts — renommer un connecteur, et rien d'autre.
//
// L'action est courte, ce qui la rend facile à casser sans le voir : sa garde de
// propriété et sa garde de portée tiennent chacune sur une ligne. Retirer
// `eq(connectors.entityId, session.entityId)` du SELECT laisse renommer le
// connecteur du voisin ; retirer le `where` de l'UPDATE renomme tout le parc.
// Les deux erreurs renvoient `ok`, et l'interface affiche un succès.
//
// Le fichier teste donc trois choses, dans cet ordre d'importance :
//   1. le connecteur d'un autre espace est introuvable, et reste intact ;
//   2. seul le connecteur visé change de nom — un témoin le prouve ;
//   3. le nom écrit est exactement celui demandé.

import { describe, it, expect, beforeAll, vi } from 'vitest';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import { eq, connectors, entities, users } from '@nodal-agents/db';

let testDb: TestDb;
let seed: Awaited<ReturnType<typeof seedMinimal>>;
let entiteVoisine = '';

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

  const [autreUser] = await testDb
    .insert(users)
    .values({ email: `voisin-conn-${Date.now()}@example.com` })
    .returning();
  const [autreEntite] = await testDb
    .insert(entities)
    .values({
      userId: autreUser!.id,
      name: 'Espace voisin',
      slug: `voisin-conn-${Date.now()}`,
    })
    .returning();
  entiteVoisine = autreEntite!.id;
});

/** Pose un connecteur dans l'espace demandé et rend sa ligne. */
async function connecteur(entityId: string, name: string, slug: string) {
  const [row] = await testDb
    .insert(connectors)
    .values({ entityId, name, slug, authType: 'api_key' })
    .returning();
  return row!;
}

async function nomDe(id: string): Promise<string | null> {
  const [row] = await testDb
    .select({ name: connectors.name })
    .from(connectors)
    .where(eq(connectors.id, id));
  return row?.name ?? null;
}

describe('renameConnectorAction', () => {
  it('renomme le connecteur visé — et lui seul', async () => {
    const { renameConnectorAction } = await import('../actions.ts');
    const cible = await connecteur(seed.entityId, 'Notion', `notion-${Date.now()}`);
    const temoin = await connecteur(seed.entityId, 'Slack', `slack-${Date.now()}`);

    const result = await renameConnectorAction(cible.id, 'Notion — équipe produit');

    expect(result.ok, result.ok ? '' : result.message).toBe(true);
    expect(await nomDe(cible.id)).toBe('Notion — équipe produit');
    expect(await nomDe(temoin.id), 'un connecteur voisin a été renommé au passage').toBe('Slack');
  });

  it('ne trouve pas le connecteur d’un AUTRE espace, et le laisse intact', async () => {
    const { renameConnectorAction } = await import('../actions.ts');
    const chezLeVoisin = await connecteur(entiteVoisine, 'Notion du voisin', `nv-${Date.now()}`);

    const result = await renameConnectorAction(chezLeVoisin.id, 'Repris');

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('not_found');
    expect(await nomDe(chezLeVoisin.id), 'le connecteur du voisin a été renommé').toBe(
      'Notion du voisin',
    );
  });

  it('refuse un identifiant absent, sans inventer de ligne', async () => {
    const { renameConnectorAction } = await import('../actions.ts');
    const avant = (await testDb.select().from(connectors)).length;

    const result = await renameConnectorAction('00000000-0000-4000-8000-000000000000', 'Fantôme');

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('not_found');
    expect((await testDb.select().from(connectors)).length).toBe(avant);
  });

  it('refuse un identifiant qui n’est pas un GUID', async () => {
    const { renameConnectorAction } = await import('../actions.ts');

    const result = await renameConnectorAction('pas-un-guid', 'Peu importe');

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('validation_failed');
  });

  it('refuse un nom vide et un nom de plus de 120 caractères', async () => {
    const { renameConnectorAction } = await import('../actions.ts');
    const cible = await connecteur(seed.entityId, 'Airtable', `airtable-${Date.now()}`);

    const vide = await renameConnectorAction(cible.id, '');
    const tropLong = await renameConnectorAction(cible.id, 'x'.repeat(121));

    expect(vide.ok).toBe(false);
    if (!vide.ok) expect(vide.code).toBe('validation_failed');
    expect(tropLong.ok).toBe(false);
    expect(await nomDe(cible.id), 'un nom invalide a été écrit').toBe('Airtable');
  });

  it('accepte exactement 120 caractères — la borne est incluse', async () => {
    const { renameConnectorAction } = await import('../actions.ts');
    const cible = await connecteur(seed.entityId, 'Firecrawl', `firecrawl-${Date.now()}`);
    const nom = 'x'.repeat(120);

    const result = await renameConnectorAction(cible.id, nom);

    expect(result.ok, result.ok ? '' : result.message).toBe(true);
    expect(await nomDe(cible.id)).toBe(nom);
  });
});
