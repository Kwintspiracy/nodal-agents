// device-actions.test.ts — Settings → Devices reads the runner and says what it refused (#946).
//
// The runner's answers are simulated at `fetch`, in the shapes its routes
// write: the actions must check them, and turn a multi-user install's refusal
// (`multi_user_host`, the requests belong to no workspace) into what the
// screen says: no request listed, the reason in one line, and a pill at 0.

import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';

let testDb: TestDb;
let seed: Awaited<ReturnType<typeof seedMinimal>>;

vi.mock('@/lib/server.ts', () => ({
  getDb: () => testDb,
  getAuthProvider: () => ({ name: 'local-trust' }),
  applyActiveEntity: (session: { userId: string; entityId: string }) => session,
}));
vi.mock('next/headers', () => ({ headers: async () => new Headers() }));
vi.mock('@nodal-agents/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@nodal-agents/auth')>();
  return { ...actual, requireAuth: async () => ({ userId: seed.userId, entityId: seed.entityId }) };
});
vi.mock('@/lib/env.ts', () => ({
  env: { RUNNER_URL: 'http://127.0.0.1:39999', WORKER_SECRET: 'test-secret' },
}));

const A = await import('../device-actions.ts');

const PENDING = {
  pairingId: '0b6f5a4e-1f2a-4c3b-9d8e-7f6a5b4c3d2e',
  name: 'Desk companion',
  capabilities: ['speaker'],
  userCode: '482913',
  from: '192.168.1.40',
  requestedAt: '2026-11-10T10:00:00.000Z',
  expiresAt: '2099-01-01T00:00:00.000Z',
  state: 'pending',
};

/** The runner, answering `pairings` the way the test says, and an empty device list. */
function runner(pairings: { status: number; body: unknown }) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const json = (status: number, body: unknown) =>
        new Response(JSON.stringify(body), {
          status,
          headers: { 'content-type': 'application/json' },
        });
      if (url.includes('/api/device-pairings')) return json(pairings.status, pairings.body);
      if (url.includes('/api/workspace-devices')) return json(200, { devices: [] });
      throw new Error(`no route for ${url}`);
    }),
  );
}

beforeAll(async () => {
  testDb = (await spinUpTestDb()).db;
  seed = await seedMinimal(testDb);
});
beforeEach(() => vi.unstubAllGlobals());
afterAll(() => vi.unstubAllGlobals());

describe('Settings → Devices, as the runner answers it @cap:parler-par-canal-externe/ecran', () => {
  it('a single-user install: the request is listed, and the pill counts it', async () => {
    runner({ status: 200, body: { pairings: [PENDING] } });
    const view = await A.getDevicesAction();
    expect(view).toMatchObject({ ok: true, data: { pairingsRefused: null, devices: [] } });
    expect(view.ok && view.data.pairings.map((p) => p.userCode)).toEqual(['482913']);
    expect(await A.countPendingPairingsAction()).toEqual({ ok: true, data: 1 });
  });

  it('a multi-user install: no request, the reason in one line, and a pill at 0', async () => {
    runner({ status: 403, body: { error: 'multi_user_host' } });
    const view = await A.getDevicesAction();
    expect(view).toEqual({
      ok: true,
      data: {
        pairings: [],
        pairingsRefused:
          'Only a single-user install can pair a device, and this one has several accounts.',
        devices: [],
        isOwner: true,
      },
    });
    expect(await A.countPendingPairingsAction()).toEqual({ ok: true, data: 0 });
  });

  it('any other refusal is said, never shown as an empty list', async () => {
    runner({ status: 403, body: { error: 'forbidden' } });
    expect(await A.getDevicesAction()).toMatchObject({ ok: false, code: 'forbidden' });
    expect(await A.countPendingPairingsAction()).toMatchObject({ ok: false, code: 'forbidden' });
  });
});
