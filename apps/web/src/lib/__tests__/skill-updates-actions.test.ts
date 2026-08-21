// skill-updates-actions.test.ts — unit tests for updateCommunitySkillAction and
// listSkillUpdatesAction (community-skill update tracking).
// Asserts on the real request sent to the runner and on real DB rows —
// never on call counts (CLAUDE.md invariant 5).

import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import { agentSkills } from '@nodal-agents/db';

let testDb: TestDb;
let seed: Awaited<ReturnType<typeof seedMinimal>>;

vi.stubEnv('WORKER_SECRET', 'test-worker-secret');

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

beforeAll(async () => {
  const result = await spinUpTestDb();
  testDb = result.db;
  seed = await seedMinimal(testDb);
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** Inserts a community skill row for the seeded entity. */
async function insertCommunitySkill(overrides: {
  slug: string;
  name: string;
  updateAvailable?: boolean;
}) {
  const [row] = await testDb
    .insert(agentSkills)
    .values({
      entityId: seed.entityId,
      name: overrides.name,
      slug: overrides.slug,
      content: 'Do the thing.',
      isCommunity: true,
      source: `owner/${overrides.slug}`,
      updateAvailable: overrides.updateAvailable ?? false,
    })
    .returning();
  if (!row) throw new Error('failed to seed community skill');
  return row;
}

describe('updateCommunitySkillAction', () => {
  it('sends {slug, entityId} to POST /api/skills/update and returns the parsed result', async () => {
    const { updateCommunitySkillAction } = await import('../actions.ts');
    await insertCommunitySkill({ slug: 'comfyui-workflows', name: 'ComfyUI Workflows' });

    const fetchMock = vi.fn().mockResolvedValue(
      Response.json({
        ok: true,
        contentChanged: true,
        scriptsChanged: true,
        scriptsAuthorizationRevoked: 2,
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await updateCommunitySkillAction('comfyui-workflows');

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toEqual({
        contentChanged: true,
        scriptsChanged: true,
        scriptsAuthorizationRevoked: 2,
      });
    }

    // Assert the actual request body/URL/auth sent to the runner.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://127.0.0.1:3001/api/skills/update');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['Authorization']).toBe(
      'Bearer test-worker-secret',
    );
    expect(JSON.parse(init.body as string)).toEqual({
      slug: 'comfyui-workflows',
      entityId: seed.entityId,
    });
  });

  it('surfaces the runner error when the update fails', async () => {
    const { updateCommunitySkillAction } = await import('../actions.ts');
    await insertCommunitySkill({ slug: 'failing-skill', name: 'Failing Skill' });

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        Response.json({
          ok: false,
          error: 'source_unreachable',
          message: 'Could not reach the skill source',
        }),
      ),
    );

    const result = await updateCommunitySkillAction('failing-skill');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('source_unreachable');
      expect(result.message).toBe('Could not reach the skill source');
    }
  });

  it('returns network_error when the runner is unreachable', async () => {
    const { updateCommunitySkillAction } = await import('../actions.ts');
    await insertCommunitySkill({ slug: 'unreachable-skill', name: 'Unreachable Skill' });

    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));

    const result = await updateCommunitySkillAction('unreachable-skill');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('network_error');
  });

  it('rejects an empty slug', async () => {
    const { updateCommunitySkillAction } = await import('../actions.ts');
    const result = await updateCommunitySkillAction('');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('validation_failed');
  });
});

describe('listSkillUpdatesAction', () => {
  it('returns only community skills with updateAvailable=true for the active entity', async () => {
    const { listSkillUpdatesAction } = await import('../actions.ts');

    await insertCommunitySkill({
      slug: 'skill-with-update',
      name: 'Skill With Update',
      updateAvailable: true,
    });
    await insertCommunitySkill({
      slug: 'skill-up-to-date',
      name: 'Skill Up To Date',
      updateAvailable: false,
    });

    const result = await listSkillUpdatesAction();
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const slugs = result.data.map((r) => r.slug);
    expect(slugs).toContain('skill-with-update');
    expect(slugs).not.toContain('skill-up-to-date');

    const notice = result.data.find((r) => r.slug === 'skill-with-update');
    expect(notice).toEqual({ slug: 'skill-with-update', name: 'Skill With Update' });
  });
});

// « Acquitter » veut dire : je garde ma version, arrête de me prévenir. C'est le
// geste qui ÉTEINT une notification de mise à jour — donc celui qui, s'il vise
// le mauvais espace, éteint la notification de quelqu'un d'autre. Comme pour les
// deux autres relais, tout le contrat est dans la requête émise.
describe('acknowledgeSkillUpdateAction', () => {
  it('poste {slug, entityId de la session} et rend le verdict du runner', async () => {
    const { acknowledgeSkillUpdateAction } = await import('../actions.ts');
    await insertCommunitySkill({
      slug: 'skill-a-acquitter',
      name: 'Skill À Acquitter',
      updateAvailable: true,
    });

    const fetchMock = vi.fn().mockResolvedValue(Response.json({ ok: true, contentChanged: false }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await acknowledgeSkillUpdateAction('skill-a-acquitter');

    expect(result.ok, result.ok ? '' : result.message).toBe(true);
    if (result.ok) expect(result.data).toEqual({ contentChanged: false });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://127.0.0.1:3001/api/skills/acknowledge-update');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['Authorization']).toBe(
      'Bearer test-worker-secret',
    );
    expect(JSON.parse(init.body as string)).toEqual({
      slug: 'skill-a-acquitter',
      entityId: seed.entityId,
    });
  });

  it('transmet contentChanged=true tel quel — le contenu avait bougé depuis', async () => {
    const { acknowledgeSkillUpdateAction } = await import('../actions.ts');

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(Response.json({ ok: true, contentChanged: true })),
    );

    const result = await acknowledgeSkillUpdateAction('peu-importe');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.contentChanged).toBe(true);
  });

  it('remonte l’erreur du runner sans la traduire', async () => {
    const { acknowledgeSkillUpdateAction } = await import('../actions.ts');

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        Response.json({
          ok: false,
          error: 'skill_has_no_source',
          message: 'That skill has no source to re-align on.',
        }),
      ),
    );

    const result = await acknowledgeSkillUpdateAction('skill-sans-source');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('skill_has_no_source');
      expect(result.message).toBe('That skill has no source to re-align on.');
    }
  });

  it('annonce network_error quand le runner ne répond pas', async () => {
    const { acknowledgeSkillUpdateAction } = await import('../actions.ts');

    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));

    const result = await acknowledgeSkillUpdateAction('skill-a-acquitter');

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('network_error');
  });

  it('refuse un slug vide sans rien émettre', async () => {
    const { acknowledgeSkillUpdateAction } = await import('../actions.ts');

    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const result = await acknowledgeSkillUpdateAction('');

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('validation_failed');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
