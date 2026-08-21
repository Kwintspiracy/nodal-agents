// install-community-skill-action.test.ts — l'action qui fait entrer du code
// étranger dans l'installation.
//
// Elle n'écrit rien elle-même : elle relaie vers le runner, qui télécharge et
// installe. Son contrat tient donc entièrement dans la REQUÊTE qu'elle émet, et
// c'est là-dessus qu'on asserte — l'URL, le porteur, et surtout le corps.
//
// Le point qui compte : `entityId` est pris de la SESSION, jamais de l'appelant.
// La signature n'expose qu'une `source`, ce qui est la bonne forme — mais rien
// ne l'empêcherait de dériver, et une skill installée dans l'espace du voisin
// est une skill que le voisin exécute. Le test fige la provenance.
//
// Le second point : sans secret runner, l'action doit refuser AVANT d'émettre
// quoi que ce soit. Un appel non authentifié parti « pour voir » est exactement
// le genre de repli silencieux que l'invariant 4 interdit.

import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';

let testDb: TestDb;
let seed: Awaited<ReturnType<typeof seedMinimal>>;

vi.stubEnv('WORKER_SECRET', 'test-worker-secret');

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
});

/** La réponse que le runner renvoie quand tout s'est bien passé. */
const SKILL_INSTALLEE = {
  slug: 'pdf-forms',
  name: 'PDF Forms',
  description: 'Remplit des formulaires PDF.',
  source: 'anthropics/skills',
  installedScripts: [],
  fileCount: 4,
  reinstalled: false,
};

describe('installCommunitySkillAction', () => {
  it('poste {source, entityId de la session} au runner, porteur inclus', async () => {
    const { installCommunitySkillAction } = await import('../actions.ts');

    const fetchMock = vi
      .fn()
      .mockResolvedValue(Response.json({ ok: true, skill: SKILL_INSTALLEE }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await installCommunitySkillAction('anthropics/skills');

    expect(result.ok, result.ok ? '' : result.message).toBe(true);
    if (result.ok) expect(result.data).toEqual(SKILL_INSTALLEE);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://127.0.0.1:3001/api/skills/install');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['Authorization']).toBe(
      'Bearer test-worker-secret',
    );
    expect(JSON.parse(init.body as string)).toEqual({
      source: 'anthropics/skills',
      entityId: seed.entityId,
    });
  });

  it('l’espace visé vient de la session — un entityId glissé dans la source ne le déplace pas', async () => {
    const { installCommunitySkillAction } = await import('../actions.ts');

    const fetchMock = vi
      .fn()
      .mockResolvedValue(Response.json({ ok: true, skill: SKILL_INSTALLEE }));
    vi.stubGlobal('fetch', fetchMock);

    // Une source qui essaie de faire passer un autre espace pour le sien.
    await installCommunitySkillAction('owner/repo?entityId=00000000-0000-0000-0000-000000000000');

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const corps = JSON.parse(init.body as string) as { source: string; entityId: string };
    expect(corps.entityId, 'l’espace d’installation a été dicté par l’appelant').toBe(
      seed.entityId,
    );
    // La source, elle, est transmise telle quelle : c'est au runner de la juger.
    expect(corps.source).toBe('owner/repo?entityId=00000000-0000-0000-0000-000000000000');
  });

  it('remonte l’erreur du runner sans la traduire', async () => {
    const { installCommunitySkillAction } = await import('../actions.ts');

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        Response.json({
          ok: false,
          error: 'skill_not_found',
          message: 'No SKILL.md at the top of that repository.',
        }),
      ),
    );

    const result = await installCommunitySkillAction('owner/vide');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('skill_not_found');
      expect(result.message).toBe('No SKILL.md at the top of that repository.');
    }
  });

  it('annonce network_error quand le runner ne répond pas', async () => {
    const { installCommunitySkillAction } = await import('../actions.ts');

    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));

    const result = await installCommunitySkillAction('anthropics/skills');

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('network_error');
  });

  it('refuse une source vide ou démesurée sans appeler le runner', async () => {
    const { installCommunitySkillAction } = await import('../actions.ts');

    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const vide = await installCommunitySkillAction('');
    const enorme = await installCommunitySkillAction('x'.repeat(2049));

    expect(vide.ok).toBe(false);
    if (!vide.ok) expect(vide.code).toBe('validation_failed');
    expect(enorme.ok).toBe(false);
    if (!enorme.ok) expect(enorme.code).toBe('validation_failed');
    expect(fetchMock, 'une source invalide est partie sur le réseau').not.toHaveBeenCalled();
  });
});

// Cas isolé : il exige un `env` reconstruit, donc un module rechargé. Gardé dans
// son propre bloc pour que le reset ne déteigne pas sur les tests ci-dessus.
describe('installCommunitySkillAction — sans secret runner', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.stubEnv('WORKER_SECRET', 'test-worker-secret');
    vi.resetModules();
  });

  it('refuse avant d’émettre la moindre requête', async () => {
    vi.stubEnv('WORKER_SECRET', undefined);
    vi.resetModules();

    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const { installCommunitySkillAction } = await import('../actions.ts');
    const result = await installCommunitySkillAction('anthropics/skills');

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('config_error');
    expect(fetchMock, 'une requête non authentifiée est partie au runner').not.toHaveBeenCalled();
  });
});
