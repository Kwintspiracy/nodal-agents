// @vitest-environment node
// whatsapp-pairing-actions.test.ts — the dashboard's WhatsApp pairing, as the
// runner sees it.
//
// Two defects found on 16/10/2026, both user-facing:
//
// 1. Since 0.9.7 the pack no longer installs @whiskeysockets/baileys from npm
//    (it needs git to install; the runner bundle carries its own copy). The
//    dashboard imports actions.ts → @nodal-agents/delivery → socket-manager,
//    so it must load with the library ABSENT. The library is mocked here as
//    missing: its factory throws what Node raises for a package not installed.
//
// 2. Both pairing actions called `/api/whatsapp-pairing?agentId=…`. The runner
//    serves `/api/whatsapp/pairing`: GET reads `agentId` from the query, POST
//    from a JSON body. Every pairing from the dashboard got a 404.
//
// Assertions are on the REQUEST the action emits: URL, method, bearer, body.

import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

let testDb: TestDb;
let seed: Awaited<ReturnType<typeof seedMinimal>>;

vi.stubEnv('WORKER_SECRET', 'test-worker-secret');

// The library is not a dependency of the web app: the specifier only resolves
// from the delivery package, so the mock is keyed on the file it resolves to
// there (a bare-specifier mock from here would intercept nothing).
const baileysEntry = createRequire(
  fileURLToPath(new URL('../../../../../packages/delivery/package.json', import.meta.url)),
).resolve('@whiskeysockets/baileys');
vi.doMock(baileysEntry, () => {
  throw new Error("Cannot find package '@whiskeysockets/baileys' imported from socket-manager.ts");
});

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
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('WhatsApp pairing from the dashboard @cap:parler-par-canal-externe/moteur', () => {
  it('the dashboard actions load without the WhatsApp library installed', async () => {
    const actions = await import('../actions.ts');

    expect(typeof actions.startWhatsAppPairingAction).toBe('function');
    expect(typeof actions.getWhatsAppPairingStatusAction).toBe('function');
  });

  it('starting pairing POSTs {agentId} as JSON to the runner route /api/whatsapp/pairing', async () => {
    const { startWhatsAppPairingAction } = await import('../actions.ts');
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ ok: true }, { status: 202 }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await startWhatsAppPairingAction(seed.agentId);

    expect(result.ok, result.ok ? '' : result.message).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://127.0.0.1:3001/api/whatsapp/pairing');
    expect(init.method).toBe('POST');
    const headers = init.headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer test-worker-secret');
    expect(headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(init.body as string)).toEqual({ agentId: seed.agentId });
  });

  it('reading the pairing status GETs /api/whatsapp/pairing?agentId= and relays the QR', async () => {
    const { startWhatsAppPairingAction, getWhatsAppPairingStatusAction } =
      await import('../actions.ts');
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ ok: true }, { status: 202 }))
      .mockResolvedValueOnce(Response.json({ status: 'qr_pending', qr: '2@QRPAYLOAD' }));
    vi.stubGlobal('fetch', fetchMock);
    // The status is only asked of the runner once a binding exists.
    await startWhatsAppPairingAction(seed.agentId);

    const result = await getWhatsAppPairingStatusAction(seed.agentId);

    expect(result.ok, result.ok ? '' : result.message).toBe(true);
    if (result.ok) expect(result.data).toMatchObject({ status: 'qr_pending', qr: '2@QRPAYLOAD' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [url, init] = fetchMock.mock.calls[1] as [string, RequestInit | undefined];
    expect(url).toBe(
      `http://127.0.0.1:3001/api/whatsapp/pairing?agentId=${encodeURIComponent(seed.agentId)}`,
    );
    expect(init?.method ?? 'GET').toBe('GET');
  });
});
