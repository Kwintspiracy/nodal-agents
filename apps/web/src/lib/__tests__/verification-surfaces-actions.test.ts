// verification-surfaces-actions.test.ts — le réglage « surfaces sous
// vérification » (D8, T23) : owner-only, l'objet COMPLET à chaque écriture,
// et seulement SON espace. Chaque cas relit la ligne entities après coup.

import { describe, it, expect, beforeAll, vi } from 'vitest';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import { eq, entities, users } from '@nodal-agents/db';

let testDb: TestDb;
let seed: Awaited<ReturnType<typeof seedMinimal>>;
let otherUserId: string;
let foreignEntityId: string;

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

const ALL = { codeTask: true, cliRuntime: true, fileOps: true, shell: true };

beforeAll(async () => {
  const result = await spinUpTestDb();
  testDb = result.db;
  seed = await seedMinimal(testDb);

  const [other] = await testDb
    .insert(users)
    .values({ email: `autre-${Date.now()}@example.com` })
    .returning();
  otherUserId = other!.id;
  const [otherEntity] = await testDb
    .insert(entities)
    .values({ userId: otherUserId, name: 'Entité voisine', slug: `voisine-${Date.now()}` })
    .returning();
  foreignEntityId = otherEntity!.id;
});

async function asNonOwner(run: () => Promise<void>) {
  await testDb.update(entities).set({ userId: otherUserId }).where(eq(entities.id, seed.entityId));
  try {
    await run();
  } finally {
    await testDb
      .update(entities)
      .set({ userId: seed.userId })
      .where(eq(entities.id, seed.entityId));
  }
}

async function stored(entityId: string): Promise<unknown> {
  const [r] = await testDb
    .select({ v: entities.verificationSurfaces })
    .from(entities)
    .where(eq(entities.id, entityId));
  return r?.v;
}

const actions = () => import('../actions.ts');

describe('setVerificationSurfacesAction', () => {
  it('bascule dans les deux sens : la ligne porte les quatre clés explicites à chaque écriture', async () => {
    const { setVerificationSurfacesAction } = await actions();
    expect((await setVerificationSurfacesAction({ ...ALL, shell: false })).ok).toBe(true);
    expect(await stored(seed.entityId)).toEqual({ ...ALL, shell: false });
    expect((await setVerificationSurfacesAction(ALL)).ok).toBe(true);
    expect(await stored(seed.entityId)).toEqual(ALL);
  });

  it('ne règle QUE son espace : la voisine reste à {} (tout activé au parseur)', async () => {
    const { setVerificationSurfacesAction } = await actions();
    await setVerificationSurfacesAction({ ...ALL, fileOps: false });
    expect(await stored(foreignEntityId)).toEqual({});
    await setVerificationSurfacesAction(ALL);
  });

  it('non-owner refusé dans les deux sens, ligne inchangée', async () => {
    const { setVerificationSurfacesAction } = await actions();
    const before = await stored(seed.entityId);
    await asNonOwner(async () => {
      for (const next of [{ ...ALL, shell: false }, ALL]) {
        const r = await setVerificationSurfacesAction(next);
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.code).toBe('forbidden');
      }
    });
    expect(await stored(seed.entityId)).toEqual(before);
  });

  it('entrée malformée : clé inconnue, valeur non booléenne, null ⇒ validation_failed, rien d’écrit', async () => {
    const { setVerificationSurfacesAction } = await actions();
    const before = await stored(seed.entityId);
    for (const raw of [{ ...ALL, extra: true }, { ...ALL, shell: 'non' }, null, { shell: false }]) {
      const r = await setVerificationSurfacesAction(raw);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe('validation_failed');
    }
    expect(await stored(seed.entityId)).toEqual(before);
  });
});

describe('getVerificationSurfacesAction', () => {
  it('rend le réglage parsé, avec isOwner pour le propriétaire et pour un tiers', async () => {
    const { getVerificationSurfacesAction } = await actions();
    await testDb
      .update(entities)
      .set({ verificationSurfaces: { shell: false } })
      .where(eq(entities.id, seed.entityId));
    const r = await getVerificationSurfacesAction();
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.surfaces).toEqual({ ...ALL, shell: false });
      expect(r.data.isOwner).toBe(true);
    }
    await asNonOwner(async () => {
      const r2 = await getVerificationSurfacesAction();
      expect(r2.ok).toBe(true);
      if (r2.ok) expect(r2.data.isOwner).toBe(false);
    });
    await testDb
      .update(entities)
      .set({ verificationSurfaces: {} })
      .where(eq(entities.id, seed.entityId));
  });
});
