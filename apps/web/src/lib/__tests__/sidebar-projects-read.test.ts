// sidebar-projects-read.test.ts — LA LECTURE du dossier « Workspaces » (#230,
// décision du propriétaire du 19/09/2026 au soir).
//
// CE QUE CE FICHIER PROUVE, et pourquoi il vaut la peine d'exister. Le dossier
// « Workspaces » du panneau Work déplie ses dix derniers projets. La tentation
// était de réutiliser `listProjectsAction`, qui alimente la PAGE des espaces :
// elle joint les travaux pour compter et dater, puis lit l'état de la preuve de
// chaque dossier, et elle n'a AUCUN plafond. La faire payer à la barre latérale
// aurait refait exactement la faute que la passe 1 de la revue de la PR #206 a
// retirée des sous-menus.
//
// Trois preuves, sur une VRAIE base (PGlite) :
//
//   1. le plafond est respecté, et il rend UNE ligne de plus que le menu ne
//      dessine — c'est cette ligne qui répond à « y en a-t-il d'autres ? » ;
//   2. l'ordre est celui de l'ENREGISTREMENT, le plus récent d'abord ;
//   3. un projet MASQUÉ n'y est pas, et un dossier jamais enregistré non plus.
//
// Mutations vérifiées : le `.limit(limit)` retiré → le premier test rougit ;
// `desc(registeredAt)` passé en ordre croissant → le deuxième ; le filtre
// `hidden` retiré → le troisième.

import { describe, it, expect, beforeAll, vi } from 'vitest';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import { codeProjects } from '@nodal-agents/db';
import { projectKey } from '@nodal-agents/shared';

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

/** Une date, en minutes depuis une origine fixe. Plus haut = plus récent. */
function quand(minutes: number): Date {
  return new Date(Date.UTC(2026, 8, 19, 0, minutes, 0));
}

beforeAll(async () => {
  const result = await spinUpTestDb();
  testDb = result.db;
  seed = await seedMinimal(testDb);

  // Le type de la table, et non une inférence : sans lui, les lignes à
  // `registeredAt` nul et celles à date forment une union que drizzle refuse.
  const lignes: (typeof codeProjects.$inferInsert)[] = [];
  // DOUZE projets enregistrés, du plus ancien au plus récent.
  for (let i = 1; i <= 12; i += 1) {
    lignes.push({
      entityId: seed.entityId,
      agentId: seed.agentId,
      projectPath: `D:/projects/p${String(i).padStart(2, '0')}`,
      // La CLÉ d'identité du dossier, que la colonne exige : la même fonction
      // que l'enregistrement, jamais une chaîne inventée pour le test.
      projectKey: projectKey(`D:/projects/p${String(i).padStart(2, '0')}`),
      displayName: `Project ${i}`,
      kind: 'code',
      hidden: false,
      registeredFrom: 'spaces',
      registeredAt: quand(i),
    });
  }
  // Un projet MASQUÉ, et le plus récent de tous : s'il remontait, il ouvrirait
  // la liste. Masquer est le geste par lequel on le retire de la vue.
  lignes.push({
    entityId: seed.entityId,
    agentId: seed.agentId,
    projectPath: 'D:/projects/hidden',
    projectKey: projectKey('D:/projects/hidden'),
    displayName: 'Hidden project',
    kind: 'code',
    hidden: true,
    registeredFrom: 'spaces',
    registeredAt: quand(99),
  });
  // Un dossier qu'un agent a touché sans qu'on l'ait déclaré : `registered_at`
  // est NULL, ce n'est pas un projet.
  lignes.push({
    entityId: seed.entityId,
    agentId: seed.agentId,
    projectPath: 'D:/projects/touched',
    projectKey: projectKey('D:/projects/touched'),
    displayName: 'Touched folder',
    kind: 'code',
    hidden: false,
    registeredFrom: 'conversation',
    registeredAt: null,
  });
  await testDb.insert(codeProjects).values(lignes);
});

describe('la lecture du dossier Workspaces @cap:travailler-sur-des-fichiers/moteur', () => {
  it('rend ce qu’on lui demande, et pas plus, sur une base qui en porte douze', async () => {
    const { listSidebarProjectsAction } = await import('../project-actions.ts');
    const r = await listSidebarProjectsAction(11);
    if (!r.ok) throw new Error(r.message);
    // ONZE : dix dessinés, et le onzième qui dit qu'il y en a d'autres.
    expect(r.data).toHaveLength(11);
  });

  it('classe par date d’ENREGISTREMENT, le plus récent d’abord', async () => {
    const { listSidebarProjectsAction } = await import('../project-actions.ts');
    const r = await listSidebarProjectsAction(3);
    if (!r.ok) throw new Error(r.message);
    // Et non par dernière activité : c'est ce que la demande dit, et les deux
    // ordres ne donnent pas la même liste.
    expect(r.data.map((p) => p.name)).toEqual(['Project 12', 'Project 11', 'Project 10']);
  });

  it('écarte un projet MASQUÉ et un dossier jamais enregistré', async () => {
    const { listSidebarProjectsAction } = await import('../project-actions.ts');
    const r = await listSidebarProjectsAction(50);
    if (!r.ok) throw new Error(r.message);
    const noms = r.data.map((p) => p.name);
    // Le masqué est le PLUS RÉCENT : s'il n'était pas écarté, il ouvrirait la
    // liste, et le test d'ordre au-dessus l'aurait déjà dit.
    expect(noms).not.toContain('Hidden project');
    expect(noms).not.toContain('Touched folder');
    expect(noms).toHaveLength(12);
  });
});
