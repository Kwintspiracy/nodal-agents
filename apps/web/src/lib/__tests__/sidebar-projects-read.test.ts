// sidebar-projects-read.test.ts — LA LECTURE de la section « Workspaces »
// (#230, refondue en #258).
//
// CE QUE CE FICHIER PROUVE, et pourquoi il vaut la peine d'exister. La section
// « Workspaces » du panneau Work montre ses dix derniers projets. La tentation
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
//   3. un projet MASQUÉ n'y est pas, et un dossier jamais enregistré non plus ;
//   4. le POINT de la planche (#258) se LIT par la chaîne qui existe — un
//      projet a des travaux, un travail a une conversation, une conversation a
//      un marqueur de lecture — et jamais par un état que le projet n'a pas.
//
// Mutations vérifiées : le `.limit(limit)` retiré → le premier test rougit ;
// `desc(registeredAt)` passé en ordre croissant → le deuxième ; le filtre
// `hidden` retiré → le troisième ; la comparaison `updated_at > read_at`
// remplacée par `IS NULL` seul → le quatrième.

import { describe, it, expect, beforeAll, vi } from 'vitest';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
// `eq` vient de `@nodal-agents/db`, qui le REEXPORTE, et jamais de
// `drizzle-orm` : seul `packages/db` importe l'ORM (regle de couche), et
// l'application web ne le porte pas dans son manifeste. Un worktree le
// resolvait quand meme par sa jonction `node_modules` ; la CI, elle, installe
// pour de bon et l'a dit.
import { agentJobs, codeProjects, conversationReads, conversations, eq } from '@nodal-agents/db';
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

/**
 * Rattache une conversation à un projet, et dit si la personne l'a LUE.
 *
 * C'est la chaîne réelle du produit, et la seule : un projet n'a pas de
 * marqueur de lecture, un travail porte son `project_id`, et le marqueur vit
 * sur la conversation de ce travail.
 */
async function rattacher(projectPath: string, lue: boolean, quandVue: Date): Promise<void> {
  const [projet] = await testDb
    .select({ id: codeProjects.id })
    .from(codeProjects)
    .where(eq(codeProjects.projectPath, projectPath));
  if (!projet) throw new Error(`no project at ${projectPath}`);

  const [conv] = await testDb
    .insert(conversations)
    .values({
      entityId: seed.entityId,
      agentId: seed.agentId,
      channel: 'dashboard',
      origin: 'user',
      title: `Thread of ${projectPath}`,
      updatedAt: quand(60),
    })
    .returning({ id: conversations.id });
  if (!conv) throw new Error('no conversation');

  await testDb.insert(agentJobs).values({
    entityId: seed.entityId,
    agentId: seed.agentId,
    projectId: projet.id,
    conversationId: conv.id,
    task: 'Do the thing',
    channel: 'dashboard',
    status: 'completed',
  });

  if (lue) {
    await testDb
      .insert(conversationReads)
      .values({ userId: seed.userId, conversationId: conv.id, readAt: quandVue });
  }
}

describe('le POINT d’un espace de travail @cap:travailler-sur-des-fichiers/moteur', () => {
  beforeAll(async () => {
    // Project 12 : une conversation LUE APRÈS sa dernière activité. Rien
    // n'attend, le point est gris.
    await rattacher('D:/projects/p12', true, quand(90));
    // Project 11 : une conversation lue AVANT sa dernière activité. Quelque
    // chose est arrivé depuis, le point est rouge.
    await rattacher('D:/projects/p11', true, quand(10));
    // Project 10 : une conversation JAMAIS ouverte. Rouge aussi.
    await rattacher('D:/projects/p10', false, quand(0));
    // Project 09 : AUCUNE conversation du tout. Sans conversation, pas de
    // non-lu — et surtout pas un point posé par défaut.
  });

  it('allume le point sur ce qui a bougé depuis la dernière ouverture', async () => {
    const { listSidebarProjectsAction } = await import('../project-actions.ts');
    const r = await listSidebarProjectsAction(4);
    if (!r.ok) throw new Error(r.message);
    expect(r.data.map((p) => [p.name, p.unread])).toEqual([
      ['Project 12', false],
      ['Project 11', true],
      ['Project 10', true],
      ['Project 9', false],
    ]);
  });

  it('n’invente AUCUN point sur un projet sans conversation', async () => {
    // La seule table qui porte un état de lecture est `conversation_reads`.
    // Un projet qu'aucun travail ne relie à une conversation n'a rien à dire,
    // et le dire quand même serait afficher un fait que rien ne vérifie
    // (invariant #4).
    const { listSidebarProjectsAction } = await import('../project-actions.ts');
    const r = await listSidebarProjectsAction(50);
    if (!r.ok) throw new Error(r.message);
    const sansFil = r.data.filter(
      (p) => !['Project 12', 'Project 11', 'Project 10'].includes(p.name),
    );
    expect(sansFil.length).toBeGreaterThan(0);
    for (const p of sansFil) expect(p.unread, p.name).toBe(false);
  });
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

  it('REFUSE un plafond absurde, au lieu de lire sans borne', async () => {
    // Une action serveur est une porte publique : le menu lui passe une
    // constante aujourd'hui, mais un zéro, un négatif ou dix mille ferait soit
    // une requête absurde, soit la lecture non bornée que cette action existe
    // justement pour éviter.
    //
    // Mutation vérifiée : la validation retirée → ce cas rougit, et `limit(0)`
    // rend une liste vide au lieu d'une erreur.
    const { listSidebarProjectsAction } = await import('../project-actions.ts');
    for (const mauvais of [0, -1, 1.5, 51]) {
      const r = await listSidebarProjectsAction(mauvais);
      expect(r.ok, `limite ${mauvais}`).toBe(false);
      if (!r.ok) expect(r.code).toBe('validation_failed');
    }
    // Et les bornes elles-mêmes passent : un refus trop large serait aussi
    // faux qu'une absence de refus.
    expect((await listSidebarProjectsAction(1)).ok).toBe(true);
    expect((await listSidebarProjectsAction(50)).ok).toBe(true);
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

// ─── La MÊME règle des deux côtés (#364) ─────────────────────────────────────
//
// La barre et la page décidaient chacune de leur côté ce qu'est un projet
// listé : la requête de la barre écartait les masqués, celle de la page les
// rendait tous, et la page les dessinait. « Remove from list » retirait donc
// le projet du menu, puis renvoyait sur une page qui le montrait toujours.
//
// Ce que ce cas tient : la page LIT le masqué (elle en fait sa section
// « Hidden »), mais la fusion l'écarte de la liste, par le MÊME prédicat que
// la requête de la barre (`isListedProject` / `listedProjectsWhere`).
//
// Mutation vérifiée : `eq(codeProjects.hidden, HIDDEN_LISTED)` retiré de
// `listedProjectsWhere` → « la barre » rougit ; `isListedProject` rendu
// toujours vrai → « la page » rougit.
describe('la barre et la page lisent la même règle @cap:travailler-sur-des-fichiers/moteur', () => {
  it('la barre n’a pas le masqué ; la page le lit, et le range hors de la liste', async () => {
    const { listSidebarProjectsAction, listProjectsAction } = await import('../project-actions.ts');
    const { mergeWorkspaces } = await import('../workspaces.ts');

    const barre = await listSidebarProjectsAction(50);
    if (!barre.ok) throw new Error(barre.message);
    expect(barre.data.map((p) => p.name)).not.toContain('Hidden project');

    const page = await listProjectsAction();
    if (!page.ok) throw new Error(page.message);
    const masque = page.data.find((p) => p.name === 'Hidden project');
    // La page le LIT — sans quoi sa section « Hidden » n'aurait rien à rendre.
    expect(masque?.hidden).toBe(true);

    const view = mergeWorkspaces({ projects: page.data, sessions: [], prefs: [] });
    expect(view.rows.map((r) => r.name)).not.toContain('Hidden project');
    expect(view.hiddenRows.map((r) => r.name)).toEqual(['Hidden project']);
    // Et les deux listes s'accordent sur ce qui RESTE.
    expect(view.rows.map((r) => r.name).sort()).toEqual(barre.data.map((p) => p.name).sort());
  });
});
