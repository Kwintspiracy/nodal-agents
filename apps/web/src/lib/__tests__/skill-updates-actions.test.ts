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
