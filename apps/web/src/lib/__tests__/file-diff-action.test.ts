// file-diff-action.test.ts — le relais du web vers le runner (P11).
//
// Ce que cette action fait vraiment tient en deux gestes : elle refuse un
// travail qui n'appartient pas à l'entité de l'appelant, et elle passe la main
// au runner avec le secret. Les assertions portent donc sur l'URL RÉELLEMENT
// appelée et l'en-tête RÉELLEMENT envoyé, jamais sur un compte d'appels.

import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import { agentJobs, entities, users } from '@nodal-agents/db';

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

vi.mock('../env.ts', () => ({
  env: { RUNNER_URL: 'http://runner.test:3001', WORKER_SECRET: 'le-secret' },
}));

beforeAll(async () => {
  const spun = await spinUpTestDb();
  testDb = spun.db;
  seed = await seedMinimal(testDb);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Le vrai `fetch`, remplacé — on garde l'appel pour l'inspecter. */
function stubFetch(body: unknown, status = 200) {
  const seen: Array<{ url: string; init: RequestInit | undefined }> = [];
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    seen.push({ url: String(url), init });
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  });
  return seen;
}

describe('getFileDiffAction', () => {
  it('appelle la route du runner avec le travail, l’appel et le secret', async () => {
    const seen = stubFetch({ kind: 'unchanged', path: 'a.txt', from: 'sha', to: 'working_tree' });
    const { getFileDiffAction } = await import('../file-diff-actions.ts');

    const res = await getFileDiffAction({
      jobId: seed.jobId,
      toolCallId: 'call-1',
      path: 'src/a.txt',
    });

    expect(res).toEqual({
      ok: true,
      data: { kind: 'unchanged', path: 'a.txt', from: 'sha', to: 'working_tree' },
    });
    expect(seen).toHaveLength(1);
    const url = new URL(seen[0]!.url);
    expect(url.origin).toBe('http://runner.test:3001');
    expect(url.pathname).toBe(`/api/jobs/${seed.jobId}/file-diff`);
    expect(url.searchParams.get('toolCallId')).toBe('call-1');
    expect(url.searchParams.get('path')).toBe('src/a.txt');
    expect(new Headers(seen[0]!.init?.headers).get('authorization')).toBe('Bearer le-secret');
  });

  it('un travail d’une AUTRE entité : refusé, et le runner n’est jamais appelé', async () => {
    const seen = stubFetch({ kind: 'unchanged' });
    const [user] = await testDb
      .insert(users)
      .values({ email: `fd-web-${Date.now()}@example.com` })
      .returning();
    const [autre] = await testDb
      .insert(entities)
      .values({ userId: user!.id, name: 'Autre', slug: `autre-${Date.now()}` })
      .returning();
    const [job] = await testDb
      .insert(agentJobs)
      .values({ entityId: autre!.id, channel: 'api', task: 'ailleurs' })
      .returning({ id: agentJobs.id });

    const { getFileDiffAction } = await import('../file-diff-actions.ts');
    const res = await getFileDiffAction({ jobId: job!.id, toolCallId: 'call-1' });

    expect(res).toEqual({ ok: false, code: 'not_found', message: 'Job not found' });
    expect(seen, "le runner a été appelé pour un travail d'une autre entité").toEqual([]);
  });

  it('un refus du runner remonte son CODE, pas une phrase inventée', async () => {
    stubFetch({ error: 'tool_call_not_found' }, 404);
    const { getFileDiffAction } = await import('../file-diff-actions.ts');
    const res = await getFileDiffAction({ jobId: seed.jobId, toolCallId: 'inconnu' });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe('tool_call_not_found');
  });

  it('une entrée mal formée ne part jamais sur le réseau', async () => {
    const seen = stubFetch({ kind: 'unchanged' });
    const { getFileDiffAction } = await import('../file-diff-actions.ts');
    const res = await getFileDiffAction({ jobId: 'pas-un-uuid', toolCallId: 'c' });
    expect(res.ok).toBe(false);
    expect(seen).toEqual([]);
  });
});
