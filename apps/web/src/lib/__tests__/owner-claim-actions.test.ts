// owner-claim-actions.test.ts — le pont local-trust → local-auth.
//
// Deux surfaces, une même panne évitée :
//   1. updateNetworkSettingsAction : basculer en LAN alors que le config porte
//      un auth.mode="local-trust" EXPLICITE écrivait un config que le CLI
//      refuse de booter (vécu le 23/08 : stack morte au restart). Le toggle
//      LAN est documenté « Sign-in required », donc il aligne le mode persisté.
//   2. claimOwnerAccountAction : sur une install migrée (utilisateur seedé,
//      zéro compte), la page de login propose de créer LE compte propriétaire.
//      L'assertion clé porte sur les rows réelles : le compte credential est
//      rattaché à l'utilisateur EXISTANT, jamais à un nouveau.

import { describe, it, expect, beforeAll, vi } from 'vitest';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import { eq, users, accounts } from '@nodal-agents/db';

let testDb: TestDb;
let seed: Awaited<ReturnType<typeof seedMinimal>>;

/** Provider injecté dans getAuthProvider — muté par les tests. */
let currentProvider: unknown = { name: 'local-trust' };

/** Config factice : readNodalaiConfig le lit, mergeNodalaiConfig l'écrit. */
let fakeConfig: Record<string, unknown> = {};

vi.mock('@/lib/server.ts', () => ({
  getDb: () => testDb,
  getAuthProvider: () => currentProvider,
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

vi.mock('@/lib/cli-config.ts', () => ({
  readNodalaiConfig: () => fakeConfig,
  mergeNodalaiConfig: (patch: Record<string, unknown>) => {
    fakeConfig = { ...fakeConfig, ...patch };
  },
}));

async function actions() {
  return import('../actions.ts');
}

beforeAll(async () => {
  const result = await spinUpTestDb();
  testDb = result.db;
  seed = await seedMinimal(testDb);
});

describe('updateNetworkSettingsAction — alignement du mode auth', () => {
  it('LAN + local-trust explicite : le mode persisté devient local-auth', async () => {
    const { updateNetworkSettingsAction } = await actions();
    fakeConfig = { bind: 'loopback', auth: { mode: 'local-trust' } };

    const r = await updateNetworkSettingsAction({ bind: 'lan' });
    expect(r.ok, r.ok ? '' : r.message).toBe(true);
    if (r.ok) expect(r.data.authModeAligned).toBe(true);

    // Le config résultant doit être BOOTABLE : plus de local-trust + lan.
    expect(fakeConfig['bind']).toBe('lan');
    expect((fakeConfig['auth'] as { mode?: string }).mode).toBe('local-auth');
  });

  it('LAN sans bloc auth : rien à aligner, le repli lan→local-auth suffit', async () => {
    const { updateNetworkSettingsAction } = await actions();
    fakeConfig = { bind: 'loopback' };

    const r = await updateNetworkSettingsAction({ bind: 'lan' });
    expect(r.ok, r.ok ? '' : r.message).toBe(true);
    if (r.ok) expect(r.data.authModeAligned).toBe(false);
    expect(fakeConfig['bind']).toBe('lan');
    expect(fakeConfig['auth']).toBeUndefined();
  });

  it('retour au loopback : le mode auth explicite est laissé tel quel', async () => {
    const { updateNetworkSettingsAction } = await actions();
    fakeConfig = { bind: 'lan', auth: { mode: 'local-auth' } };

    const r = await updateNetworkSettingsAction({ bind: 'loopback' });
    expect(r.ok, r.ok ? '' : r.message).toBe(true);
    if (r.ok) expect(r.data.authModeAligned).toBe(false);
    expect(fakeConfig['bind']).toBe('loopback');
    expect((fakeConfig['auth'] as { mode?: string }).mode).toBe('local-auth');
  });
});

describe('claimOwnerAccountAction', () => {
  it('refusée hors mode local-auth', async () => {
    const { claimOwnerAccountAction } = await actions();
    currentProvider = { name: 'local-trust' };
    const r = await claimOwnerAccountAction({ email: 'q@example.com', password: 'long-enough-1' });
    expect(r.ok).toBe(false);
    expect(r.ok ? '' : r.code).toBe('unavailable');
  });

  it('entrée invalide : rien n’est écrit', async () => {
    const { claimOwnerAccountAction } = await actions();
    const { createLocalAuthProvider } =
      await vi.importActual<typeof import('@nodal-agents/auth')>('@nodal-agents/auth');
    currentProvider = createLocalAuthProvider({
      db: testDb,
      baseURL: 'http://localhost:3000',
      secret: 'test-secret-that-is-long-enough-32ch',
    });

    const r = await claimOwnerAccountAction({ email: 'pas-un-email', password: 'long-enough-1' });
    expect(r.ok).toBe(false);
    expect(await testDb.select().from(accounts)).toHaveLength(0);
  });

  it('réclame l’utilisateur EXISTANT : email mis à jour, credential rattaché, même id', async () => {
    const { claimOwnerAccountAction } = await actions();
    const r = await claimOwnerAccountAction({
      email: 'quentin@example.com',
      password: 'mot-de-passe-solide',
    });
    expect(r.ok, r.ok ? '' : r.message).toBe(true);

    const [owner] = await testDb.select().from(users).where(eq(users.id, seed.userId));
    expect(owner!.email).toBe('quentin@example.com');
    expect(owner!.emailVerified).toBe(true);

    const rows = await testDb.select().from(accounts);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.userId).toBe(seed.userId);
    expect(rows[0]!.providerId).toBe('credential');
  });

  it('one-shot : la seconde réclamation est claim_closed et ne touche pas le compte', async () => {
    const { claimOwnerAccountAction } = await actions();
    const r = await claimOwnerAccountAction({
      email: 'intrus@example.com',
      password: 'un-autre-mdp-1',
    });
    expect(r.ok).toBe(false);
    expect(r.ok ? '' : r.code).toBe('claim_closed');

    const [owner] = await testDb.select().from(users).where(eq(users.id, seed.userId));
    expect(owner!.email).toBe('quentin@example.com');
    expect(await testDb.select().from(accounts)).toHaveLength(1);
  });
});
