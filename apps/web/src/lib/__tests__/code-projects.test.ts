// code-projects.test.ts — la vue par projet de l'onglet Code.
//
// Deux surfaces, deux preuves :
//   1. deriveProjectRoot — sur un VRAI arbre disque (repos git fabriqués dans
//      un tmpdir), jamais sur un mock de fs : détection de racine, règle de
//      l'enfant direct, vote majoritaire, résolution des chemins relatifs par
//      label, et disparition d'un projet dont le dossier a été supprimé.
//   2. les deux gestes du propriétaire — des lignes RÉELLES dans
//      `code_projects`, scopées entité, réversibles, sans jamais toucher le
//      dossier.

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import { and, eq, codeProjects, entities, users } from '@nodal-agents/db';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  deriveProjectRoot,
  projectNameFromPath,
  isDriveRoot,
  isInsideWorkspace,
  type WorkspaceRef,
} from '../code-projects.ts';

let testDb: TestDb;
let seed: Awaited<ReturnType<typeof seedMinimal>>;

/** Arbre disque réel : racine/repoA(.git)/src/x.ts, racine/repoB(.git)/y.ts, racine/plain/z.md */
let racine = '';
const norm = (p: string) => p.replace(/\\/g, '/');

let foreignEntityId = '';
/** Un autre utilisateur — sert à rendre la session NON-propriétaire. */
let foreignOwnerUserId = '';

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
  foreignOwnerUserId = autreUser!.id;
});

afterAll(async () => {
  if (racine) await rm(racine, { recursive: true, force: true });
});

/**
 * Des dossiers attachés à un agent. Le label est dérivé du nom du dossier —
 * c'est lui qui résout un chemin relatif de la forme Nodal (`label/a.ts`).
 */
const ws = (...paths: string[]): WorkspaceRef[] =>
  paths.map((p) => ({
    label: p.split('/').filter(Boolean).pop() ?? p,
    path: p,
    hiddenFromCode: false,
  }));

/** Le même, MASQUÉ de l'onglet Code (0087). */
const wsMasque = (...paths: string[]): WorkspaceRef[] =>
  ws(...paths).map((w) => ({ ...w, hiddenFromCode: true }));

/**
 * Le cas COURANT : l'agent qui a écrit est aussi celui dont on regarde les
 * dossiers. Les deux se séparent dans une délégation, et c'est le test
 * « labels homonymes » plus bas qui couvre ce cas-là.
 */
const deriveFor = (
  paths: string[],
  workspaces: WorkspaceRef[],
  memo: Map<string, string | null>,
): string | null =>
  deriveProjectRoot(
    paths.map((rawPath) => ({ rawPath, workspaces })),
    workspaces,
    memo,
  );

const insideFor = (rawPath: string, workspaces: WorkspaceRef[]): boolean =>
  isInsideWorkspace({ rawPath, workspaces }, workspaces);

describe('deriveProjectRoot (vrai disque)', () => {
  const memo = () => new Map<string, string | null>();

  it('remonte au dépôt git depuis un fichier profond', () => {
    const root = deriveFor([`${racine}/repoA/src/x.ts`], ws(racine), memo());
    expect(root).toBe(`${racine}/repoA`);
  });

  it('deux repos = deux projets, et le vote majoritaire tranche un pipeline mixte', () => {
    expect(deriveFor([`${racine}/repoB/y.ts`], ws(racine), memo())).toBe(`${racine}/repoB`);
    const mixed = deriveFor(
      [`${racine}/repoA/src/x.ts`, `${racine}/repoA/src/x.ts`, `${racine}/repoB/y.ts`],
      ws(racine),
      memo(),
    );
    expect(mixed, 'le vote majoritaire n’a pas choisi le repo dominant').toBe(`${racine}/repoA`);
  });

  it('sans marqueur : le SOUS-DOSSIER de premier niveau, jamais le workspace-conteneur', () => {
    // Constat Quentin 25/08 (calorie-counter) : rendre le workspace entier
    // fusionnerait toutes les apps d'un Dev\ partagé en un seul projet.
    const root = deriveFor([`${racine}/plain/z.md`], ws(racine), memo());
    expect(root).toBe(`${racine}/plain`);
  });

  it('workspace-CONTENEUR : deux apps sans git = DEUX projets distincts', async () => {
    await mkdir(join(racine, 'dev', 'calorie-counter'), { recursive: true });
    await writeFile(join(racine, 'dev', 'calorie-counter', 'index.html'), '<!doctype html>');
    await writeFile(join(racine, 'dev', 'calorie-counter', 'app.js'), '// app');
    await mkdir(join(racine, 'dev', 'todo-app'), { recursive: true });
    await writeFile(join(racine, 'dev', 'todo-app', 'main.js'), '// autre app');
    const racineDev = `${racine}/dev`;

    expect(deriveFor([`${racine}/dev/calorie-counter/app.js`], ws(racineDev), memo())).toBe(
      `${racine}/dev/calorie-counter`,
    );
    expect(deriveFor([`${racine}/dev/todo-app/main.js`], ws(racineDev), memo())).toBe(
      `${racine}/dev/todo-app`,
    );
  });

  it('workspace = LE projet (manifeste à sa racine) : src/ ne fragmente pas', async () => {
    await mkdir(join(racine, 'monapp', 'src'), { recursive: true });
    await writeFile(join(racine, 'monapp', 'package.json'), '{}');
    await writeFile(join(racine, 'monapp', 'src', 'x.ts'), 'export {}');
    const app = `${racine}/monapp`;

    expect(deriveFor([`${racine}/monapp/src/x.ts`], ws(app), memo())).toBe(app);
  });

  it('la profondeur ne change RIEN : le projet est l’enfant direct du dossier attaché', async () => {
    // L'ancienne règle cherchait un manifeste à TOUS les niveaux et rendait
    // donc `.../app`, parce que le `index.html` est là. Le rangement reste
    // mauvais — c'est au skill « dev » de le corriger à la source — mais
    // l'affichage devient prévisible.
    await mkdir(join(racine, 'dev', 'calorie-counter', 'app'), { recursive: true });
    await writeFile(join(racine, 'dev', 'calorie-counter', 'app', 'index.html'), '<!doctype html>');
    const racineDev = `${racine}/dev`;

    expect(
      deriveFor([`${racine}/dev/calorie-counter/app/index.html`], ws(racineDev), memo()),
      'le projet a été pris plus bas que l’enfant direct',
    ).toBe(`${racine}/dev/calorie-counter`);

    await mkdir(join(racine, 'dev', 'profond', 'a', 'b', 'c'), { recursive: true });
    await writeFile(join(racine, 'dev', 'profond', 'a', 'b', 'c', 'd.ts'), 'export {}');
    expect(deriveFor([`${racine}/dev/profond/a/b/c/d.ts`], ws(racineDev), memo())).toBe(
      `${racine}/dev/profond`,
    );
  });

  it('un dossier SUPPRIMÉ disparaît de la liste, même si ses éditions restent en base', async () => {
    // Constat Quentin (26/08) : « des dossiers qui ont été supprimés
    // apparaissent malgré tout dans l'onglet code ».
    //
    // Les tool_calls vivent pour toujours ; le dossier, non. Sans ce contrôle,
    // un projet supprimé il y a six mois reste dans la liste et AUCUN geste ne
    // l'en sort — masquer un fantôme n'est pas une réponse. Le contexte injecté
    // aux agents faisait déjà cette vérification : les deux vues étaient en
    // désaccord, et c'est l'interface qui avait tort.
    const ephemere = join(racine, 'dev', 'ephemere');
    await mkdir(ephemere, { recursive: true });
    await writeFile(join(ephemere, 'a.ts'), 'export {}');
    const racineDev = `${racine}/dev`;
    const fichier = `${racine}/dev/ephemere/a.ts`;

    expect(
      deriveFor([fichier], ws(racineDev), memo()),
      'le projet n’apparaît pas alors que son dossier existe',
    ).toBe(`${racine}/dev/ephemere`);

    await rm(ephemere, { recursive: true, force: true });

    expect(
      deriveFor([fichier], ws(racineDev), memo()),
      'un dossier supprimé apparaît encore comme projet',
    ).toBeNull();
  });

  it('un chemin RELATIF se résout par le LABEL, pas en le collant au premier dossier venu', () => {
    // Constat P1 de la revue Codex (26/08). `vault/note.md` est la forme Nodal
    // d'une écriture dans le dossier étiqueté `vault` — pas un chemin à coller
    // au premier dossier venu.
    const workspaces = [
      { label: 'dev', path: `${racine}/repoA`, hiddenFromCode: false },
      { label: 'vault', path: `${racine}/plain`, hiddenFromCode: false },
    ];

    // `repoA` porte un `.git` : le dossier attaché EST le projet, ses
    // sous-dossiers ne le fragmentent pas.
    expect(deriveFor(['dev/src/x.ts'], workspaces, memo())).toBe(`${racine}/repoA`);
    // Et le coffre est bien reconnu comme le coffre, pas comme du repoA.
    expect(deriveFor(['vault/note.md'], workspaces, memo())).toBe(`${racine}/plain`);

    expect(insideFor('dev/src/x.ts', workspaces)).toBe(true);
    expect(insideFor('vault/note.md', workspaces)).toBe(true);
  });

  it('labels HOMONYMES : le chemin relatif se lit chez SON auteur, pas chez le voisin', async () => {
    // Constat P1 de la revue Codex (26/08). Un label n'est unique que par
    // AGENT. Dans un pipeline délégué, l'orchestrateur et son worker ont chacun
    // un dossier étiqueté `workspace` — mettre tous les dossiers du pipeline
    // dans le même sac faisait gagner le premier label trouvé, et l'écriture du
    // worker était attribuée au dossier de l'orchestrateur.
    //
    // Mauvais projet, mauvais décompte, et rien à l'écran pour le signaler.
    await mkdir(join(racine, 'chef', 'notes'), { recursive: true });
    await mkdir(join(racine, 'ouvrier', 'app'), { recursive: true });
    await writeFile(join(racine, 'ouvrier', 'app', 'a.ts'), 'export {}');

    const dossiersDuChef = [{ label: 'workspace', path: `${racine}/chef`, hiddenFromCode: false }];
    const dossiersDeLOuvrier = [
      { label: 'workspace', path: `${racine}/ouvrier`, hiddenFromCode: false },
    ];
    // Le pipeline voit les deux — c'est bien la mise en commun qui posait
    // problème, pas le fait de connaître les deux dossiers.
    const duPipeline = [...dossiersDuChef, ...dossiersDeLOuvrier];

    expect(
      deriveProjectRoot(
        [{ rawPath: 'workspace/app/a.ts', workspaces: dossiersDeLOuvrier }],
        duPipeline,
        memo(),
      ),
      'l’écriture de l’ouvrier a été attribuée au dossier du chef',
    ).toBe(`${racine}/ouvrier/app`);

    // Et symétriquement, une écriture du CHEF reste chez le chef.
    await writeFile(join(racine, 'chef', 'notes', 'b.md'), '# note');
    expect(
      deriveProjectRoot(
        [{ rawPath: 'workspace/notes/b.md', workspaces: dossiersDuChef }],
        duPipeline,
        memo(),
      ),
    ).toBe(`${racine}/chef/notes`);
  });

  it('un dossier MASQUÉ ne produit AUCUN projet, quel que soit le nombre de sous-dossiers', async () => {
    // Constat de Quentin (26/08), sur ses vraies données : son coffre Obsidian
    // produisait 8 projets — un par dossier de premier niveau où le Researcher
    // avait écrit. « Ça peut en compter des milliers. » Il a raison : ce nombre
    // n'est borné par rien.
    //
    // Masquer le dossier les fait tous disparaître d'un seul geste.
    const coffre = join(racine, 'coffre-masque');
    for (const sujet of ['Physique', 'Santé', 'Warhammer', 'Research']) {
      await mkdir(join(coffre, sujet), { recursive: true });
      await writeFile(join(coffre, sujet, 'note.md'), '# note');
    }
    const ecrits = ['Physique', 'Santé', 'Warhammer', 'Research'].map(
      (s) => `${norm(coffre)}/${s}/note.md`,
    );

    // Non masqué : quatre projets distincts, un par sujet.
    const projetsVus = new Set(
      ecrits.map((f) => deriveFor([f], ws(norm(coffre)), memo())).filter(Boolean),
    );
    expect(projetsVus.size, 'le coffre devrait produire un projet par sujet').toBe(4);

    // Masqué : plus rien, pour chacun des quatre.
    for (const f of ecrits) {
      expect(
        deriveFor([f], wsMasque(norm(coffre)), memo()),
        `« ${f} » produit encore un projet alors que son dossier est masqué`,
      ).toBeNull();
    }
    expect(insideFor(ecrits[0]!, wsMasque(norm(coffre)))).toBe(false);
  });

  it('le LABEL d’un dossier masqué reste lu — sinon ses écritures polluent un autre projet', async () => {
    // Le piège de cette fonctionnalité, et il est vicieux : si masquer retirait
    // le dossier de la RÉSOLUTION en plus de la liste des racines, alors
    // `vault/note.md` ne serait plus reconnu comme une écriture dans le coffre.
    // Il se recollerait au seul dossier restant — et le coffre réapparaîtrait
    // sous le projet de l'agent, précisément là où on vient de le chasser.
    //
    // C'est le constat P1 que la revue Codex avait fait sur 0085 ; il
    // s'appliquerait mot pour mot ici.
    // Le piège se referme SEULEMENT si le recollage aboutit à un vrai dossier.
    // Sans ce `repoA/vault`, retirer le coffre de la résolution rendrait quand
    // même `null` — faute de chemin existant — et le test passerait sans rien
    // prouver. Il serait décoratif.
    await mkdir(join(racine, 'repoA', 'vault'), { recursive: true });
    await writeFile(join(racine, 'repoA', 'vault', 'note.md'), '# leurre');

    const workspaces: WorkspaceRef[] = [
      { label: 'dev', path: `${racine}/repoA`, hiddenFromCode: false },
      { label: 'vault', path: `${racine}/plain`, hiddenFromCode: true },
    ];

    expect(
      deriveProjectRoot([{ rawPath: 'vault/note.md', workspaces }], workspaces, memo()),
      'l’écriture du coffre masqué a été recollée à un autre dossier',
    ).toBeNull();
    // Et le dossier suivi, lui, continue de fonctionner normalement.
    expect(deriveProjectRoot([{ rawPath: 'dev/src/x.ts', workspaces }], workspaces, memo())).toBe(
      `${racine}/repoA`,
    );
  });

  it('une écriture hors de TOUT dossier attaché ne produit AUCUN projet', () => {
    expect(
      deriveFor([`${racine}/repoA/src/x.ts`], ws(`${racine}/plain`), memo()),
      'une écriture non rattachable a produit un projet',
    ).toBeNull();
    expect(deriveFor([`${racine}/repoA/src/x.ts`], [], memo())).toBeNull();
    expect(insideFor(`${racine}/repoA/src/x.ts`, ws(`${racine}/plain`))).toBe(false);
  });

  it('un dossier attaché NICHÉ dans un autre gagne — le plus spécifique', async () => {
    // Sans le tri par longueur, le parent avalerait l'enfant et le projet
    // remonterait d'un cran.
    await mkdir(join(racine, 'dev', 'niche', 'monapp'), { recursive: true });
    await writeFile(join(racine, 'dev', 'niche', 'monapp', 'a.ts'), 'export {}');
    const parent = `${racine}/dev`;
    const enfant = `${racine}/dev/niche`;

    expect(deriveFor([`${racine}/dev/niche/monapp/a.ts`], ws(parent, enfant), memo())).toBe(
      `${racine}/dev/niche/monapp`,
    );
  });

  it('un chemin RELATIF sans label connu est résolu par existence sur disque', () => {
    // Deux workspaces candidats — seul `racine` contient réellement le fichier.
    const root = deriveFor(['repoA/src/x.ts'], ws(`${racine}/repoB`, racine), memo());
    expect(root).toBe(`${racine}/repoA`);
  });

  it('aucun chemin exploitable → null (tiroir « Autres »)', () => {
    expect(deriveFor([], ws(racine), memo())).toBeNull();
    expect(deriveFor(['inconnu/relatif.ts'], [], memo())).toBeNull();
  });

  it('projectNameFromPath rend le basename', () => {
    expect(projectNameFromPath('D:/APPS/NodalAI')).toBe('NodalAI');
    expect(projectNameFromPath('/srv/mon-site')).toBe('mon-site');
  });
});

describe('les deux gestes du propriétaire (lignes réelles)', () => {
  it('masquer écrit LA ligne, lister la rend, démasquer la remet à false — le dossier reste intact', async () => {
    const { setCodeProjectHiddenAction, listCodeProjectPrefsAction } =
      await import('../actions.ts');
    const projectPath = `${racine}/repoA`;

    const hide = await setCodeProjectHiddenAction({ projectPath, hidden: true });
    expect(hide.ok, hide.ok ? '' : hide.message).toBe(true);

    const [row] = await testDb
      .select()
      .from(codeProjects)
      .where(
        and(eq(codeProjects.projectPath, projectPath), eq(codeProjects.entityId, seed.entityId)),
      );
    expect(row, 'aucune ligne écrite').toBeDefined();
    expect(row!.hidden).toBe(true);

    const list = await listCodeProjectPrefsAction();
    expect(list.ok).toBe(true);
    if (list.ok) {
      expect(list.data.find((p) => p.projectPath === projectPath)?.hidden).toBe(true);
    }

    // Masquer est un état d'UI : le dossier réel n'a pas bougé.
    expect(existsSync(join(racine, 'repoA', 'src', 'x.ts'))).toBe(true);

    const show = await setCodeProjectHiddenAction({ projectPath, hidden: false });
    expect(show.ok).toBe(true);
    const [after] = await testDb
      .select()
      .from(codeProjects)
      .where(
        and(eq(codeProjects.projectPath, projectPath), eq(codeProjects.entityId, seed.entityId)),
      );
    expect(after!.hidden, 'le projet est resté masqué après démasquage').toBe(false);
  });

  it('démasquer NE PERD PAS le nom choisi — les deux gestes cohabitent sur la même ligne', async () => {
    // Le piège de l'implémentation précédente : masquer/démasquer était un
    // INSERT/DELETE. Porté tel quel sur une table qui contient aussi le nom,
    // un simple démasquage aurait effacé un renommage sans que rien ne le dise.
    const { setCodeProjectHiddenAction, renameCodeProjectAction, listCodeProjectPrefsAction } =
      await import('../actions.ts');
    const projectPath = `${racine}/plain`;

    expect((await renameCodeProjectAction({ projectPath, displayName: 'Mon coffre' })).ok).toBe(
      true,
    );
    expect((await setCodeProjectHiddenAction({ projectPath, hidden: true })).ok).toBe(true);
    expect((await setCodeProjectHiddenAction({ projectPath, hidden: false })).ok).toBe(true);

    const list = await listCodeProjectPrefsAction();
    expect(list.ok).toBe(true);
    if (list.ok) {
      const pref = list.data.find((p) => p.projectPath === projectPath);
      expect(pref?.displayName, 'le nom choisi a été perdu au démasquage').toBe('Mon coffre');
      expect(pref?.hidden).toBe(false);
    }
  });

  it('masquer puis démasquer avec une AUTRE casse Windows défait bien le geste', async () => {
    // Constat P1 de la revue Codex (26/08). Le même projet peut être remonté
    // avec des casses différentes selon la session. Un upsert sur l'égalité
    // SQL créait alors DEUX lignes : celle à `hidden=true` continuait de gagner
    // dans l'interface comme dans le contexte, et le projet restait masqué sans
    // aucun moyen de le rétablir. Un geste réversible qui ne se défait pas est
    // pire qu'un geste absent.
    const { setCodeProjectHiddenAction, listCodeProjectPrefsAction } =
      await import('../actions.ts');
    const majuscules = 'C:/Dev/MonApp';
    const minuscules = 'c:/dev/monapp';

    expect((await setCodeProjectHiddenAction({ projectPath: majuscules, hidden: true })).ok).toBe(
      true,
    );
    expect((await setCodeProjectHiddenAction({ projectPath: minuscules, hidden: false })).ok).toBe(
      true,
    );

    const rows = (
      await testDb.select().from(codeProjects).where(eq(codeProjects.entityId, seed.entityId))
    ).filter((r) => r.projectPath.toLowerCase() === minuscules);
    expect(rows, 'une seconde ligne a été créée pour la même casse différente').toHaveLength(1);
    expect(rows[0]!.hidden, 'le projet est resté masqué malgré le démasquage').toBe(false);

    const list = await listCodeProjectPrefsAction();
    expect(list.ok).toBe(true);
    if (list.ok) {
      expect(
        list.data.filter((p) => p.projectPath.toLowerCase() === minuscules && p.hidden),
      ).toHaveLength(0);
    }
  });

  it('des DOUBLONS de casse hérités d’une vieille base sont tous défaits d’un coup', async () => {
    // Constat Codex (26/08). La contrainte d'unicité porte sur le TEXTE exact,
    // héritée de `code_project_archives` (0083) : une base mise à jour peut
    // déjà contenir deux lignes ne différant que par la casse. N'en corriger
    // qu'une laissait l'autre à `hidden=true`, et le projet restait masqué pour
    // toujours — le démasquage semblait fonctionner sans rien changer.
    //
    // Les deux lignes sont posées ICI parce qu'elles sont la CONDITION du
    // scénario (une base héritée), pas le résultat qu'on mesure : ce qu'on
    // mesure, c'est ce que l'action en fait.
    const { setCodeProjectHiddenAction } = await import('../actions.ts');
    await testDb.insert(codeProjects).values([
      { entityId: seed.entityId, projectPath: 'D:/Legacy/App', hidden: true },
      { entityId: seed.entityId, projectPath: 'd:/legacy/app', hidden: true },
    ]);

    const r = await setCodeProjectHiddenAction({ projectPath: 'D:/Legacy/App', hidden: false });
    expect(r.ok, r.ok ? '' : r.message).toBe(true);

    const rows = (
      await testDb.select().from(codeProjects).where(eq(codeProjects.entityId, seed.entityId))
    ).filter((p) => p.projectPath.toLowerCase() === 'd:/legacy/app');
    expect(rows).toHaveLength(2);
    expect(
      rows.filter((p) => p.hidden),
      'un doublon est resté masqué : le projet ne peut plus être rétabli',
    ).toHaveLength(0);
  });

  it('renommer avec une chaîne vide rend son nom au DOSSIER (null, pas une chaîne vide)', async () => {
    const { renameCodeProjectAction } = await import('../actions.ts');
    const projectPath = `${racine}/repoB`;

    await renameCodeProjectAction({ projectPath, displayName: '  Portail client  ' });
    const [named] = await testDb
      .select()
      .from(codeProjects)
      .where(
        and(eq(codeProjects.projectPath, projectPath), eq(codeProjects.entityId, seed.entityId)),
      );
    expect(named!.displayName, 'le nom n’a pas été détouré des espaces').toBe('Portail client');

    await renameCodeProjectAction({ projectPath, displayName: '   ' });
    const [cleared] = await testDb
      .select()
      .from(codeProjects)
      .where(
        and(eq(codeProjects.projectPath, projectPath), eq(codeProjects.entityId, seed.entityId)),
      );
    expect(cleared!.displayName, 'un nom vidé doit valoir NULL, pas une chaîne vide').toBeNull();
  });

  it('masquer deux fois = une seule ligne, et l’espace voisin ne voit rien', async () => {
    const { setCodeProjectHiddenAction, listCodeProjectPrefsAction } =
      await import('../actions.ts');
    const projectPath = `${racine}/dev/todo-app`;

    await setCodeProjectHiddenAction({ projectPath, hidden: true });
    await setCodeProjectHiddenAction({ projectPath, hidden: true });
    const rows = await testDb
      .select()
      .from(codeProjects)
      .where(
        and(eq(codeProjects.projectPath, projectPath), eq(codeProjects.entityId, seed.entityId)),
      );
    expect(rows).toHaveLength(1);

    // Le voisin masque le MÊME chemin : la liste de la session ne voit que la
    // sienne.
    await testDb
      .insert(codeProjects)
      .values({ entityId: foreignEntityId, projectPath: `${racine}/dev/voisin`, hidden: true });
    const list = await listCodeProjectPrefsAction();
    expect(list.ok).toBe(true);
    if (list.ok) {
      expect(list.data.some((p) => p.projectPath === projectPath)).toBe(true);
      expect(
        list.data.filter((p) => p.projectPath === `${racine}/dev/voisin`),
        'le rangement du voisin a fuité dans la liste',
      ).toHaveLength(0);
    }
  });
});

describe('garde-fous ajoutés par la revue P1 (25/08)', () => {
  it('une racine de disque n’est JAMAIS un projet — et les DEUX dérivations en conviennent', async () => {
    // Un workspace configuré sur C:\ matcherait tout le disque et produirait
    // un « projet » nommé Users. Mieux vaut aucun projet qu'un projet faux.
    //
    // Le test porte sur le prédicat plutôt que sur `deriveProjectRoot` seul :
    // via la dérivation, le cas `C:/` ne prouve rien sur une CI Linux (aucun
    // chemin POSIX ne commence par `C:/`, donc le résultat serait null même
    // sans la garde). Le prédicat, lui, répond partout.
    //
    // La MÊME table de cas est rejouée sur le prédicat du runner
    // (apps/runner/src/tests/job/code-projects-drive-root.test.ts). Les deux
    // dérivations ont divergé une fois — l'onglet Code masquait un projet que
    // le prompt système annonçait quand même, détenteurs compris.
    for (const p of ['', '/', '//', 'C:', 'C:/', 'c:/', 'D:/']) {
      expect(isDriveRoot(p), `« ${p} » devrait être une racine de disque`).toBe(true);
    }
    for (const p of ['/home/kwint', 'C:/Users', 'C:/Users/kwint/Dev/app']) {
      expect(isDriveRoot(p), `« ${p} » n’est PAS une racine de disque`).toBe(false);
    }

    // Et de bout en bout : un workspace posé sur une racine ne produit rien.
    const memo = new Map<string, string | null>();
    expect(deriveFor([`${racine}/plain/z.md`], ws('/'), memo)).toBeNull();
    expect(deriveFor([`${racine}/plain/z.md`], ws('C:/'), memo)).toBeNull();
  });

  it('masquer ET renommer sont réservés au PROPRIÉTAIRE de l’espace', async () => {
    const { setCodeProjectHiddenAction, renameCodeProjectAction } = await import('../actions.ts');
    const projectPath = `${racine}/repoA/hors-limite`;

    // La session devient non-propriétaire le temps des appels.
    await testDb
      .update(entities)
      .set({ userId: foreignOwnerUserId })
      .where(eq(entities.id, seed.entityId));
    try {
      const hide = await setCodeProjectHiddenAction({ projectPath, hidden: true });
      expect(hide.ok).toBe(false);
      expect(hide.ok ? '' : hide.code).toBe('forbidden');

      const rename = await renameCodeProjectAction({ projectPath, displayName: 'Squatté' });
      expect(rename.ok).toBe(false);
      expect(rename.ok ? '' : rename.code).toBe('forbidden');

      const rows = await testDb
        .select()
        .from(codeProjects)
        .where(
          and(eq(codeProjects.projectPath, projectPath), eq(codeProjects.entityId, seed.entityId)),
        );
      expect(rows, 'un non-propriétaire a rangé un projet').toHaveLength(0);
    } finally {
      await testDb
        .update(entities)
        .set({ userId: seed.userId })
        .where(eq(entities.id, seed.entityId));
    }
  });
});
