// folder-browse-action.test.ts — l'explorateur de dossiers côté serveur.
//
// Cette action LIT le disque de l'hôte et le montre dans le navigateur : ce
// qu'il faut prouver n'est pas « ça liste », c'est ce que ça expose et à qui.
// D'où l'ordre des contrats : owner-only d'abord (l'arborescence appartient à
// l'hôte), puis « dossiers seulement, jamais de fichiers », sur un VRAI
// répertoire posé sur le disque — jamais sur un mock de fs.

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import { eq, entities, users } from '@nodal-agents/db';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, normalize } from 'node:path';

let testDb: TestDb;
let seed: Awaited<ReturnType<typeof seedMinimal>>;

/** Racine jetable réelle sur le disque : alpha/, beta/, note.txt. */
let racine = '';

let otherUserId = '';

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

  racine = await mkdtemp(join(tmpdir(), 'nodal-browse-test-'));
  await mkdir(join(racine, 'alpha'));
  await mkdir(join(racine, 'beta'));
  await writeFile(join(racine, 'note.txt'), 'pas un dossier');

  const [autreUser] = await testDb
    .insert(users)
    .values({ email: `voisin-browse-${Date.now()}@example.com` })
    .returning();
  otherUserId = autreUser!.id;
});

afterAll(async () => {
  if (racine) await rm(racine, { recursive: true, force: true });
});

/** Rend la session non-propriétaire le temps d'un test, puis restaure. */
async function asNonOwner(run: () => Promise<void>) {
  await testDb.update(entities).set({ userId: otherUserId }).where(eq(entities.id, seed.entityId));
  try {
    await run();
  } finally {
    await testDb
      .update(entities)
      .set({ userId: seed.userId })
      .where(eq(entities.id, seed.entityId));
  }
}

describe('browseServerFoldersAction', () => {
  it('liste les DOSSIERS d’un répertoire réel — jamais les fichiers', async () => {
    const { browseServerFoldersAction } = await import('../actions.ts');

    const result = await browseServerFoldersAction(racine);
    expect(result.ok, result.ok ? '' : result.message).toBe(true);
    if (!result.ok) return;

    expect(result.data.path).toBe(normalize(racine));
    expect(result.data.parent).toBe(dirname(normalize(racine)));
    expect(result.data.home).toBe(homedir());
    expect(result.data.truncated).toBe(false);
    // Les deux dossiers, avec leur chemin absolu complet — et note.txt ABSENT.
    expect(result.data.dirs).toEqual([
      { name: 'alpha', path: join(normalize(racine), 'alpha') },
      { name: 'beta', path: join(normalize(racine), 'beta') },
    ]);
  });

  it('refuse un non-propriétaire — l’arborescence du disque appartient à l’hôte', async () => {
    const { browseServerFoldersAction } = await import('../actions.ts');

    await asNonOwner(async () => {
      const result = await browseServerFoldersAction(racine);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('forbidden');
    });
  });

  it('refuse un chemin relatif', async () => {
    const { browseServerFoldersAction } = await import('../actions.ts');

    const result = await browseServerFoldersAction('notes/sous-dossier');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('validation_failed');
  });

  it('un dossier inexistant est une erreur ANNONCÉE, pas une liste vide', async () => {
    const { browseServerFoldersAction } = await import('../actions.ts');

    const result = await browseServerFoldersAction(join(racine, 'n-existe-pas'));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('not_found');
  });

  it('null liste les racines : les lecteurs sur Windows, « / » sur POSIX', async () => {
    const { browseServerFoldersAction } = await import('../actions.ts');

    const result = await browseServerFoldersAction(null);
    expect(result.ok, result.ok ? '' : result.message).toBe(true);
    if (!result.ok) return;

    if (process.platform === 'win32') {
      expect(result.data.path).toBeNull();
      expect(result.data.parent).toBeNull();
      expect(result.data.dirs.length).toBeGreaterThan(0);
      for (const d of result.data.dirs) {
        expect(d.path).toMatch(/^[A-Z]:\\$/);
      }
      // Le lecteur qui porte le tmpdir du test existe forcément.
      const lecteurDuTest = `${normalize(racine).slice(0, 1).toUpperCase()}:\\`;
      expect(result.data.dirs.map((d) => d.path)).toContain(lecteurDuTest);
    } else {
      expect(result.data.path).toBe('/');
      expect(result.data.parent).toBeNull();
    }
  });
});
