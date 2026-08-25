// code-projects.test.ts — la vue par projet de l'onglet Code.
//
// Deux surfaces, deux preuves :
//   1. deriveProjectRoot — sur un VRAI arbre disque (repos git fabriqués dans
//      un tmpdir), jamais sur un mock de fs : détection de racine git,
//      séparation multi-repos, vote majoritaire, repli workspace, résolution
//      des chemins relatifs par existence.
//   2. l'archivage — des lignes RÉELLES dans code_project_archives, scopées
//      entité, réversibles, sans jamais toucher le dossier.

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import { eq, codeProjectArchives, entities, users } from '@nodal-agents/db';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deriveProjectRoot, projectNameFromPath } from '../code-projects.ts';

let testDb: TestDb;
let seed: Awaited<ReturnType<typeof seedMinimal>>;

/** Arbre disque réel : racine/repoA(.git)/src/x.ts, racine/repoB(.git)/y.ts, racine/plain/z.md */
let racine = '';
const norm = (p: string) => p.replace(/\\/g, '/');

let foreignEntityId = '';

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

  racine = norm(await mkdtemp(join(tmpdir(), 'nodal-proj-test-')));
  await mkdir(join(racine, 'repoA', '.git'), { recursive: true });
  await mkdir(join(racine, 'repoA', 'src'), { recursive: true });
  await writeFile(join(racine, 'repoA', 'src', 'x.ts'), 'export {}');
  await mkdir(join(racine, 'repoB', '.git'), { recursive: true });
  await writeFile(join(racine, 'repoB', 'y.ts'), 'export {}');
  await mkdir(join(racine, 'plain'), { recursive: true });
  await writeFile(join(racine, 'plain', 'z.md'), '# notes');

  const [autreUser] = await testDb
    .insert(users)
    .values({ email: `voisin-proj-${Date.now()}@example.com` })
    .returning();
  const [autreEntite] = await testDb
    .insert(entities)
    .values({
      userId: autreUser!.id,
      name: 'Espace voisin',
      slug: `voisin-proj-${Date.now()}`,
    })
    .returning();
  foreignEntityId = autreEntite!.id;
});

afterAll(async () => {
  if (racine) await rm(racine, { recursive: true, force: true });
});

describe('deriveProjectRoot (vrai disque)', () => {
  const memo = () => new Map<string, string | null>();

  it('remonte au dépôt git depuis un fichier profond', () => {
    const root = deriveProjectRoot([`${racine}/repoA/src/x.ts`], [racine], memo());
    expect(root).toBe(`${racine}/repoA`);
  });

  it('deux repos = deux projets, et le vote majoritaire tranche un pipeline mixte', () => {
    expect(deriveProjectRoot([`${racine}/repoB/y.ts`], [racine], memo())).toBe(`${racine}/repoB`);
    const mixed = deriveProjectRoot(
      [`${racine}/repoA/src/x.ts`, `${racine}/repoA/src/x.ts`, `${racine}/repoB/y.ts`],
      [racine],
      memo(),
    );
    expect(mixed, 'le vote majoritaire n’a pas choisi le repo dominant').toBe(`${racine}/repoA`);
  });

  it('sans marqueur : le SOUS-DOSSIER de premier niveau, jamais le workspace-conteneur', () => {
    // Constat Quentin 25/08 (calorie-counter) : rendre le workspace entier
    // fusionnerait toutes les apps d'un Dev\ partagé en un seul projet.
    const root = deriveProjectRoot([`${racine}/plain/z.md`], [racine], memo());
    expect(root).toBe(`${racine}/plain`);
  });

  it('workspace-CONTENEUR : deux apps sans git = DEUX projets distincts', async () => {
    await mkdir(join(racine, 'dev', 'calorie-counter'), { recursive: true });
    await writeFile(join(racine, 'dev', 'calorie-counter', 'index.html'), '<!doctype html>');
    await writeFile(join(racine, 'dev', 'calorie-counter', 'app.js'), '// app');
    await mkdir(join(racine, 'dev', 'todo-app'), { recursive: true });
    await writeFile(join(racine, 'dev', 'todo-app', 'main.js'), '// autre app');
    const ws = `${racine}/dev`;

    // calorie-counter porte un marqueur (index.html) → son dossier.
    expect(deriveProjectRoot([`${racine}/dev/calorie-counter/app.js`], [ws], memo())).toBe(
      `${racine}/dev/calorie-counter`,
    );
    // todo-app n'en porte aucun → le sous-dossier de premier niveau quand même.
    expect(deriveProjectRoot([`${racine}/dev/todo-app/main.js`], [ws], memo())).toBe(
      `${racine}/dev/todo-app`,
    );
  });

  it('workspace = LE projet (manifeste à sa racine) : src/ ne fragmente pas', async () => {
    await mkdir(join(racine, 'monapp', 'src'), { recursive: true });
    await writeFile(join(racine, 'monapp', 'package.json'), '{}');
    await writeFile(join(racine, 'monapp', 'src', 'x.ts'), 'export {}');
    const ws = `${racine}/monapp`;

    expect(deriveProjectRoot([`${racine}/monapp/src/x.ts`], [ws], memo())).toBe(ws);
  });

  it('un chemin RELATIF (forme Nodal) est résolu par existence sur disque', () => {
    // Deux workspaces candidats — seul `racine` contient réellement le fichier.
    const other = `${racine}/repoB`;
    const root = deriveProjectRoot(['repoA/src/x.ts'], [other, racine], memo());
    expect(root).toBe(`${racine}/repoA`);
  });

  it('aucun chemin exploitable → null (tiroir « Autres »)', () => {
    expect(deriveProjectRoot([], [racine], memo())).toBeNull();
    expect(deriveProjectRoot(['inconnu/relatif.ts'], [], memo())).toBeNull();
  });

  it('projectNameFromPath rend le basename', () => {
    expect(projectNameFromPath('D:/APPS/NodalAI')).toBe('NodalAI');
    expect(projectNameFromPath('/srv/mon-site')).toBe('mon-site');
  });
});

describe('archivage des projets (lignes réelles)', () => {
  it('archiver écrit LA ligne, lister la rend, désarchiver la supprime — le dossier reste intact', async () => {
    const { setCodeProjectArchivedAction, listArchivedCodeProjectsAction } =
      await import('../actions.ts');
    const projectPath = `${racine}/repoA`;

    const archive = await setCodeProjectArchivedAction({ projectPath, archived: true });
    expect(archive.ok, archive.ok ? '' : archive.message).toBe(true);

    const [row] = await testDb
      .select()
      .from(codeProjectArchives)
      .where(eq(codeProjectArchives.projectPath, projectPath));
    expect(row, 'aucune ligne d’archive écrite').toBeDefined();
    expect(row!.entityId).toBe(seed.entityId);

    const list = await listArchivedCodeProjectsAction();
    expect(list.ok).toBe(true);
    if (list.ok) expect(list.data).toContain(projectPath);

    // L'archivage est un état d'UI : le dossier réel n'a pas bougé.
    expect(existsSync(join(racine, 'repoA', 'src', 'x.ts'))).toBe(true);

    const restore = await setCodeProjectArchivedAction({ projectPath, archived: false });
    expect(restore.ok).toBe(true);
    const after = await testDb
      .select()
      .from(codeProjectArchives)
      .where(eq(codeProjectArchives.projectPath, projectPath));
    expect(after, 'la ligne d’archive a survécu au désarchivage').toHaveLength(0);
  });

  it('archiver deux fois = une seule ligne (upsert), et l’entité voisine ne voit rien', async () => {
    const { setCodeProjectArchivedAction, listArchivedCodeProjectsAction } =
      await import('../actions.ts');
    const projectPath = `${racine}/repoB`;

    await setCodeProjectArchivedAction({ projectPath, archived: true });
    await setCodeProjectArchivedAction({ projectPath, archived: true });
    const rows = await testDb
      .select()
      .from(codeProjectArchives)
      .where(eq(codeProjectArchives.projectPath, projectPath));
    expect(rows).toHaveLength(1);

    // Une archive du voisin, même chemin : la liste de la session ne la
    // compte qu'UNE fois — la sienne.
    await testDb
      .insert(codeProjectArchives)
      .values({ entityId: foreignEntityId, projectPath: `${racine}/repoA` });
    const list = await listArchivedCodeProjectsAction();
    expect(list.ok).toBe(true);
    if (list.ok) {
      expect(list.data).toContain(projectPath);
      expect(
        list.data.filter((p) => p === `${racine}/repoA`),
        'l’archive du voisin a fuité dans la liste',
      ).toHaveLength(0);
    }
  });
});
