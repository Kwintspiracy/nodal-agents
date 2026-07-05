// host-config-actions.test.ts — unit tests for the mono-user guard (M-1).
//
// updateAuthSettingsAction and updateNetworkSettingsAction rewrite
// ~/.nodalai/config.json, which applies to the ENTIRE host process, not to
// one workspace. Asserts on the real behaviour: allowed with exactly one
// local-auth user account, refused once a second account exists.

import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import { users } from '@nodal-agents/db';

let testDb: TestDb;
let seed: Awaited<ReturnType<typeof seedMinimal>>;

vi.mock('@/lib/server.ts', () => ({
  getDb: () => testDb,
  getAuthProvider: () => ({ name: 'local-trust' }),
  applyActiveEntity: (session: { userId: string; entityId?: string }) => ({
    ...session,
    entityId: seed?.entityId ?? session.entityId ?? '',
  }),
}));

vi.mock('next/headers', () => ({
  headers: async () => new Headers(),
  cookies: async () => ({
    set: () => {},
    get: () => null,
    delete: () => {},
  }),
}));

vi.mock('next/cache', () => ({
  revalidatePath: () => {},
}));

vi.mock('@nodal-agents/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@nodal-agents/auth')>();
  return {
    ...actual,
    requireAuth: async () => ({
      userId: 'mock-user-id',
      entityId: seed?.entityId ?? 'mock-entity-id',
    }),
  };
});

vi.mock('@/lib/cli-config.ts', () => ({
  readNodalaiConfig: () => ({ auth: { mode: 'local-trust' }, bind: 'loopback' }),
  mergeNodalaiConfig: () => {},
}));

beforeAll(async () => {
  const result = await spinUpTestDb();
  testDb = result.db;
  seed = await seedMinimal(testDb);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('mono-user host config guard', () => {
  it('updateAuthSettingsAction succeeds with a single local-auth user', async () => {
    const { updateAuthSettingsAction } = await import('../actions.ts');
    const result = await updateAuthSettingsAction({ mode: 'local-auth', clearGoogle: false });
    expect(result.ok).toBe(true);
  });

  it('updateAuthSettingsAction is refused once a second user account exists', async () => {
    const { updateAuthSettingsAction } = await import('../actions.ts');
    await testDb
      .insert(users)
      .values({ email: `second-user-${Date.now()}@example.com` })
      .returning();

    const result = await updateAuthSettingsAction({ mode: 'local-trust', clearGoogle: false });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('multi_user_host');
  });

  it('updateNetworkSettingsAction is refused once a second user account exists', async () => {
    const { updateNetworkSettingsAction } = await import('../actions.ts');
    // The previous test already inserted a second user; this DB is shared
    // across the describe block (no per-test reset), so ≥2 users already exist.
    const result = await updateNetworkSettingsAction({ bind: 'lan' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('multi_user_host');
  });
});
