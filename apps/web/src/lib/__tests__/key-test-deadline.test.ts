// key-test-deadline.test.ts — testing a key always comes back (#608)
//
// The provider transport turns undici's own timeouts off, so that they never
// cut a model the turn clocks allow to think for 600 s. A key test brings no
// deadline of its own: against an endpoint that accepts the connection and
// never answers, it would wait for ever. It gets the transport's default
// deadline instead, shortened here through NODAL_PROVIDER_CALL_TIMEOUT_MS,
// and the person reads a failure, not a spinner.

import http from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';

const previous = vi.hoisted(() => {
  const value = process.env['NODAL_PROVIDER_CALL_TIMEOUT_MS'];
  process.env['NODAL_PROVIDER_CALL_TIMEOUT_MS'] = '400';
  return value;
});
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';

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

vi.mock('@nodal-agents/secrets', () => ({
  encrypt: (v: string) => v,
  decrypt: (v: string) => v,
  isEncrypted: () => false,
  last4: (v: string) => v.slice(-4),
}));

beforeAll(async () => {
  const result = await spinUpTestDb();
  testDb = result.db;
  seed = await seedMinimal(testDb);
});

afterEach(() => {
  vi.restoreAllMocks();
});

let server: http.Server;
const sockets = new Set<Socket>();

beforeAll(async () => {
  // Accepts every request and never sends a header.
  server = http.createServer(() => {});
  server.on('connection', (s) => sockets.add(s));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
});

afterAll(async () => {
  for (const s of sockets) s.destroy();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (previous === undefined) delete process.env['NODAL_PROVIDER_CALL_TIMEOUT_MS'];
  else process.env['NODAL_PROVIDER_CALL_TIMEOUT_MS'] = previous;
});

describe('testing a key against a silent endpoint (#608) @cap:choisir-modele/moteur', () => {
  it('comes back in bounded time with a failure the person can read', async () => {
    const { testLlmKeyAction } = await import('../actions.ts');
    const port = (server.address() as AddressInfo).port;

    const result = await testLlmKeyAction({
      provider: 'openai-compatible',
      baseUrl: `http://127.0.0.1:${port}/v1`,
      apiKey: 'sk-test',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('connection_failed');
      // The default deadline ended it, and the person is told so.
      expect(result.message).toBe(
        `provider call to http://127.0.0.1:${port} got no answer within 400 ms (no deadline was given by the caller)`,
      );
    }
  });
});
