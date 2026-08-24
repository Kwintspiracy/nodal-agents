// password-change.test.ts — le mot de passe se change depuis Settings.
//
// La surface web n'est qu'un fetch vers l'endpoint better-auth
// `/api/auth/change-password` — ce qu'il faut prouver n'est donc pas le
// formulaire, c'est la CHAÎNE : notre instance better-auth (schéma mappé sur
// nos tables users/accounts/sessions) accepte bien ce endpoint, vérifie
// l'ancien mot de passe, et le résultat est RÉEL — l'ancien mot de passe ne
// signe plus, le nouveau signe. Tout passe par handleAuthRequest (le même
// chemin que le catch-all /api/auth/[...all]), jamais par un mock de crypto.

import { describe, it, expect, beforeAll, vi } from 'vitest';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';

let testDb: TestDb;
let seed: Awaited<ReturnType<typeof seedMinimal>>;

/** Provider injecté dans getAuthProvider — le vrai LocalAuthProvider ici. */
let currentProvider: unknown = { name: 'local-trust' };

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

const EMAIL = 'quentin@example.com';
const OLD_PASSWORD = 'ancien-mdp-solide';
const NEW_PASSWORD = 'nouveau-mdp-encore-plus-solide';
const BASE = 'http://localhost:3000/api/auth';

type Provider = { handleAuthRequest: (req: Request) => Promise<Response | null> };

function post(path: string, body: unknown, cookie?: string): Request {
  return new Request(`${BASE}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(cookie ? { cookie } : {}),
    },
    body: JSON.stringify(body),
  });
}

async function signIn(provider: Provider, password: string): Promise<Response | null> {
  return provider.handleAuthRequest(post('/sign-in/email', { email: EMAIL, password }));
}

beforeAll(async () => {
  const result = await spinUpTestDb();
  testDb = result.db;
  seed = await seedMinimal(testDb);

  const { createLocalAuthProvider } =
    await vi.importActual<typeof import('@nodal-agents/auth')>('@nodal-agents/auth');
  currentProvider = createLocalAuthProvider({
    db: testDb,
    baseURL: 'http://localhost:3000',
    secret: 'test-secret-that-is-long-enough-32ch',
  });

  // Le compte propriétaire, créé par le même chemin que la prod (claim).
  const { claimOwnerAccountAction } = await import('../actions.ts');
  const claim = await claimOwnerAccountAction({ email: EMAIL, password: OLD_PASSWORD });
  expect(claim.ok, claim.ok ? '' : claim.message).toBe(true);
});

describe('change-password (chaîne better-auth réelle)', () => {
  it('un mauvais ancien mot de passe est refusé — et l’ancien signe toujours', async () => {
    const provider = currentProvider as Provider;
    const session = await signIn(provider, OLD_PASSWORD);
    expect(session?.status).toBe(200);
    const cookie = session!.headers.get('set-cookie')!;
    expect(cookie).toBeTruthy();

    const res = await provider.handleAuthRequest(
      post(
        '/change-password',
        { currentPassword: 'pas-le-bon', newPassword: NEW_PASSWORD, revokeOtherSessions: true },
        cookie,
      ),
    );
    expect(res?.status, 'un mauvais ancien mot de passe a été accepté').toBe(400);

    const still = await signIn(provider, OLD_PASSWORD);
    expect(still?.status, 'l’ancien mot de passe ne signe plus alors que rien n’a changé').toBe(
      200,
    );
  });

  it('change réellement le mot de passe : l’ancien ne signe PLUS, le nouveau signe', async () => {
    const provider = currentProvider as Provider;
    const session = await signIn(provider, OLD_PASSWORD);
    expect(session?.status).toBe(200);
    const cookie = session!.headers.get('set-cookie')!;

    const res = await provider.handleAuthRequest(
      post(
        '/change-password',
        { currentPassword: OLD_PASSWORD, newPassword: NEW_PASSWORD, revokeOtherSessions: true },
        cookie,
      ),
    );
    expect(res?.status, 'le changement a été refusé').toBe(200);

    const withOld = await signIn(provider, OLD_PASSWORD);
    expect(withOld?.status, 'l’ANCIEN mot de passe signe encore après le changement').not.toBe(200);
    const withNew = await signIn(provider, NEW_PASSWORD);
    expect(withNew?.status, 'le NOUVEAU mot de passe ne signe pas').toBe(200);
  });

  it('sans session, l’endpoint refuse — pas de changement anonyme', async () => {
    const provider = currentProvider as Provider;
    const res = await provider.handleAuthRequest(
      post('/change-password', { currentPassword: NEW_PASSWORD, newPassword: 'peu-importe-123' }),
    );
    expect(res?.status ?? 401, 'un changement de mot de passe sans session est passé').not.toBe(
      200,
    );

    const withNew = await signIn(provider, NEW_PASSWORD);
    expect(withNew?.status).toBe(200);
  });
});
