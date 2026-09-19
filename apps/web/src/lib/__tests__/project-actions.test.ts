// project-actions.test.ts — le REGISTRE des projets vu de l'écran (P5).
//
// Deux choses sortent d'ici et ne se rattrapent pas : une ligne en base et un
// DOSSIER sur le disque de Quentin. Les tests assertent donc les deux, relus,
// jamais `result.ok`.
//
// Les gardes passent avant les chemins heureux — le contrat qui compte n'est
// pas « la création marche », c'est « la création ne sort JAMAIS du terrain »,
// et il se prouve en tentant d'en sortir.

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import {
  eq,
  and,
  agents,
  agentJobs,
  agentWorkspaces,
  codeProjects,
  conversations,
  entities,
  users,
  verificationRuns,
} from '@nodal-agents/db';
import { projectKey } from '@nodal-agents/shared';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, rm, readdir, symlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let testDb: TestDb;
let seed: Awaited<ReturnType<typeof seedMinimal>>;

/** Racine jetable : tous les terrains de ces tests vivent là-dessous. */
let racine = '';

/** Le terrain de la session, et son jumeau chez le voisin. */
const terrain = { workspaceId: '', path: '' };
const voisin = { entityId: '', agentId: '', workspaceId: '', path: '' };

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
  racine = await mkdtemp(join(tmpdir(), 'nodal-projets-'));

  terrain.path = join(racine, 'terrain').replace(/\\/g, '/');
  const [ws] = await testDb
    .insert(agentWorkspaces)
    .values({
      agentId: seed.agentId,
      entityId: seed.entityId,
      label: 'terrain',
      path: terrain.path,
    })
    .returning({ id: agentWorkspaces.id });
  terrain.workspaceId = ws!.id;

  // L'espace d'à côté — jamais celui de la session.
  const [autreUser] = await testDb
    .insert(users)
    .values({ email: `voisin-projets-${Date.now()}@example.com` })
    .returning();
  const [autreEntite] = await testDb
    .insert(entities)
    .values({
      userId: autreUser!.id,
      name: 'Espace voisin',
      slug: `voisin-projets-${Date.now()}`,
    })
    .returning();
  voisin.entityId = autreEntite!.id;
  const [autreAgent] = await testDb
    .insert(agents)
    .values({
      entityId: voisin.entityId,
      name: 'Agent du voisin',
      slug: `agent-voisin-projets-${Date.now()}`,
      personality: 'Pas le vôtre.',
    })
    .returning();
  voisin.agentId = autreAgent!.id;
  voisin.path = join(racine, 'terrain-voisin').replace(/\\/g, '/');
  const [wsVoisin] = await testDb
    .insert(agentWorkspaces)
    .values({
      agentId: voisin.agentId,
      entityId: voisin.entityId,
      label: 'terrain',
      path: voisin.path,
    })
    .returning({ id: agentWorkspaces.id });
  voisin.workspaceId = wsVoisin!.id;
});

afterAll(async () => {
  if (racine) await rm(racine, { recursive: true, force: true });
});

/** La ligne `code_projects` de ce chemin, relue par sa CLÉ d'identité. */
async function ligneDuProjet(path: string) {
  const [row] = await testDb
    .select()
    .from(codeProjects)
    .where(
      and(eq(codeProjects.entityId, seed.entityId), eq(codeProjects.projectKey, projectKey(path))),
    );
  return row ?? null;
}

describe('createProjectAction', () => {
  it('crée le dossier ET la ligne enregistrée — relus tous les deux', async () => {
    const { createProjectAction } = await import('../project-actions.ts');

    const result = await createProjectAction({
      name: 'Projet X',
      agentId: seed.agentId,
      workspaceId: terrain.workspaceId,
      subfolder: 'projet-x',
      kind: 'code',
    });
    expect(result.ok).toBe(true);

    const attendu = `${terrain.path}/projet-x`;
    // Le dossier est là — c'est la moitié qui ne se rattrape pas.
    expect(existsSync(attendu)).toBe(true);

    const ligne = await ligneDuProjet(attendu);
    expect(ligne).not.toBeNull();
    expect(ligne!.projectPath).toBe(attendu);
    expect(ligne!.projectKey).toBe(projectKey(attendu));
    expect(ligne!.displayName).toBe('Projet X');
    expect(ligne!.kind).toBe('code');
    expect(ligne!.agentId).toBe(seed.agentId);
    expect(ligne!.registeredFrom).toBe('spaces');
    expect(ligne!.registeredAt).toBeInstanceOf(Date);
  });

  it('le même dossier deux fois : already_registered, et la ligne ne bouge pas', async () => {
    const { createProjectAction } = await import('../project-actions.ts');

    const second = await createProjectAction({
      name: 'Projet X renommé',
      agentId: seed.agentId,
      workspaceId: terrain.workspaceId,
      subfolder: 'projet-x',
      kind: 'documents',
    });
    expect(second).toEqual({
      ok: false,
      code: 'already_registered',
      message: 'This folder is already a registered project',
    });

    // Ni le nom ni le type n'ont été réécrits par la tentative refusée.
    const ligne = await ligneDuProjet(`${terrain.path}/projet-x`);
    expect(ligne!.displayName).toBe('Projet X');
    expect(ligne!.kind).toBe('code');
  });

  it('un dossier qui CONTIENT un projet enregistré est refusé', async () => {
    // Le champ vide ne vise plus le terrain (il dérive du nom du projet), mais
    // un dossier PARENT reste atteignable : `api` enregistré, puis on tente le
    // dossier qui le contient.
    const { createProjectAction } = await import('../project-actions.ts');
    const enfant = await createProjectAction({
      name: 'API',
      agentId: seed.agentId,
      workspaceId: terrain.workspaceId,
      subfolder: 'produit/api',
      kind: 'code',
    });
    expect(enfant.ok, 'préparation').toBe(true);

    const result = await createProjectAction({
      name: 'Produit',
      agentId: seed.agentId,
      workspaceId: terrain.workspaceId,
      subfolder: 'produit',
      kind: 'code',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('overlaps_registered');
    expect(result.message).toContain('already holds the project "api"');
    expect(result.message, 'le geste, pas seulement le refus').toContain('Name a subfolder above');
  });

  it('le refus COMPTE les projets en cause, il n’en nomme pas qu’un', async () => {
    // Sur le terrain de Quentin, quatre projets ; le message n'en citait qu'un
    // et laissait croire à un cas isolé.
    const { createProjectAction } = await import('../project-actions.ts');
    for (const nom of ['alpha', 'beta', 'gamma']) {
      const r = await createProjectAction({
        name: nom,
        agentId: seed.agentId,
        workspaceId: terrain.workspaceId,
        subfolder: `groupe/${nom}`,
        kind: 'code',
      });
      expect(r.ok, `préparation : ${nom}`).toBe(true);
    }

    const result = await createProjectAction({
      name: 'Groupe',
      agentId: seed.agentId,
      workspaceId: terrain.workspaceId,
      subfolder: 'groupe',
      kind: 'code',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain('3 projects');
    expect(result.message).toContain('Name a subfolder above');
  });

  it('un nom de dossier VIDE prend le nom du projet, il ne prend plus le terrain', async () => {
    // Le geste attendu d'un formulaire de création. Laisser le champ vide
    // signifiait « le dossier lui-même devient le projet » — ce qui a fait d'un
    // « Recipes » tout le dossier `Dev` (08/09/2026). Il signifie maintenant
    // « nomme-le pour moi », et la dérivation est celle que l'écran affiche.
    const { createProjectAction } = await import('../project-actions.ts');
    const r = await createProjectAction({
      name: 'Idées de Recettes',
      agentId: seed.agentId,
      workspaceId: terrain.workspaceId,
      subfolder: '',
      kind: 'code',
    });
    expect(r.ok, r.ok ? '' : `${r.code} ${r.message}`).toBe(true);
    if (!r.ok) return;
    // Accents retirés, lettre conservée : « Idées » donne « idees ».
    expect(r.data.path).toBe(`${terrain.path}/idees-de-recettes`);
    // Le dossier est relu à l'emplacement que l'action REND, pas à un chemin
    // reconstruit : `racine` et le terrain ne sont pas le même dossier ici.
    expect(existsSync(r.data.path)).toBe(true);
  });

  it('un nom de projet SANS lettre ni chiffre est refusé plutôt que deviné', async () => {
    const { createProjectAction } = await import('../project-actions.ts');
    const r = await createProjectAction({
      name: '🙂 ---',
      agentId: seed.agentId,
      workspaceId: terrain.workspaceId,
      subfolder: '',
      kind: 'code',
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe('validation_failed');
    expect(r.message).toContain('nothing to derive one from');
  });

  it('un projet dont le DOSSIER a disparu n’avale pas ses voisins', async () => {
    // Revue Codex PR #49, passe 4. La comparaison physique passait par
    // `realNearestAncestor`, qui remonte au premier ancêtre EXISTANT : un
    // projet enregistré dont le dossier avait été supprimé y remontait à son
    // parent, et tout voisin créé sous ce parent paraissait « dedans ». Le
    // registre refusait alors un projet légitime — et laissait son dossier
    // créé derrière lui.
    const { createProjectAction } = await import('../project-actions.ts');

    // Un projet enregistré, puis son dossier effacé du disque.
    const cree = await createProjectAction({
      name: 'Disparu',
      agentId: seed.agentId,
      workspaceId: terrain.workspaceId,
      subfolder: 'disparu',
      kind: 'code',
    });
    expect(cree.ok).toBe(true);
    await rm(join(racine, 'disparu'), { recursive: true, force: true });
    expect(existsSync(join(racine, 'disparu'))).toBe(false);

    // Un VOISIN, sans aucun chevauchement avec lui.
    const voisin = await createProjectAction({
      name: 'Voisin',
      agentId: seed.agentId,
      workspaceId: terrain.workspaceId,
      subfolder: 'voisin-du-disparu',
      kind: 'code',
    });
    expect(voisin.ok, voisin.ok ? '' : `refusé : ${voisin.code} ${voisin.message}`).toBe(true);
  });

  it('un dossier VOISIN, lui, passe : « projet-x » n’avale pas « projet-x-bis »', async () => {
    // La frontière est celle du SEGMENT. Sans elle, la garde de chevauchement
    // refuserait un projet parfaitement légitime — le remède serait alors pire
    // que le mal qu'il corrige.
    const { createProjectAction } = await import('../project-actions.ts');

    const result = await createProjectAction({
      name: 'Projet X bis',
      agentId: seed.agentId,
      workspaceId: terrain.workspaceId,
      subfolder: 'projet-x-bis',
      kind: 'code',
    });
    expect(result.ok).toBe(true);
  });

  it('un sous-dossier qui remonte : refusé, et RIEN au-dessus du terrain', async () => {
    const { createProjectAction } = await import('../project-actions.ts');

    const result = await createProjectAction({
      name: 'Evil',
      agentId: seed.agentId,
      workspaceId: terrain.workspaceId,
      subfolder: '../evil',
      kind: 'code',
    });
    expect(result).toEqual({
      ok: false,
      code: 'validation_failed',
      message: 'Subfolder must be a relative path inside the workspace',
    });

    // Le dossier voisin n'a pas été créé, et aucune ligne ne le désigne.
    expect(existsSync(join(racine, 'evil'))).toBe(false);
    expect((await readdir(racine)).sort()).not.toContain('evil');
    expect(await ligneDuProjet(`${racine.replace(/\\/g, '/')}/evil`)).toBeNull();
  });

  it('un chemin ABSOLU en sous-dossier est refusé de la même façon', async () => {
    const { createProjectAction } = await import('../project-actions.ts');
    const result = await createProjectAction({
      name: 'Ailleurs',
      agentId: seed.agentId,
      workspaceId: terrain.workspaceId,
      subfolder: join(racine, 'ailleurs').replace(/\\/g, '/'),
      kind: 'code',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('validation_failed');
    expect(existsSync(join(racine, 'ailleurs'))).toBe(false);
  });

  it('le terrain d’une AUTRE entité n’existe pas ici', async () => {
    const { createProjectAction } = await import('../project-actions.ts');

    const result = await createProjectAction({
      name: 'Chez le voisin',
      agentId: voisin.agentId,
      workspaceId: voisin.workspaceId,
      subfolder: 'vol',
      kind: 'code',
    });
    expect(result).toEqual({
      ok: false,
      code: 'workspace_not_found',
      message: 'Workspace not found for this agent',
    });
    expect(existsSync(join(racine, 'terrain-voisin', 'vol'))).toBe(false);
  });

  it('une jonction posée dans le terrain ne fait pas sortir la création (revue passe 27)', async () => {
    const { createProjectAction } = await import('../project-actions.ts');
    // `terrain/lien` pointe HORS du terrain : le texte du chemin est dedans,
    // le disque non. Une jonction de dossier se crée sans droit particulier,
    // sur Windows comme ailleurs.
    const ailleurs = join(racine, 'ailleurs-reel');
    await mkdir(ailleurs, { recursive: true });
    await mkdir(terrain.path, { recursive: true });
    await symlink(ailleurs, join(terrain.path, 'lien'), 'junction');

    const result = await createProjectAction({
      name: 'Par le lien',
      agentId: seed.agentId,
      workspaceId: terrain.workspaceId,
      subfolder: 'lien/externe',
      kind: 'code',
    });
    expect(result).toEqual({
      ok: false,
      code: 'validation_failed',
      message: 'Resolved path escapes the workspace',
    });
    // Rien n'a été créé de l'autre côté du lien, et aucune ligne ne le désigne.
    expect(existsSync(join(ailleurs, 'externe'))).toBe(false);
    expect(await ligneDuProjet(`${terrain.path}/lien/externe`)).toBeNull();
  });

  it('une ligne de COMPTABILITÉ devient le projet, sa preuve conservée', async () => {
    const { createProjectAction } = await import('../project-actions.ts');
    const chemin = `${terrain.path}/deja-touche`;

    // Ce que l'intention de mutation laisse derrière elle : une ligne sans
    // `registered_at`, avec l'epoch et la configuration de preuve du dossier.
    await testDb.insert(codeProjects).values({
      entityId: seed.entityId,
      projectPath: chemin,
      projectKey: projectKey(chemin),
      verifyCommands: [{ command: 'pnpm test', timeoutSeconds: 600 }],
      verificationEpoch: 3,
    });

    const result = await createProjectAction({
      name: 'Déjà touché',
      agentId: seed.agentId,
      workspaceId: terrain.workspaceId,
      subfolder: 'deja-touche',
      kind: 'documents',
    });
    expect(result.ok).toBe(true);

    const lignes = await testDb
      .select()
      .from(codeProjects)
      .where(
        and(
          eq(codeProjects.entityId, seed.entityId),
          eq(codeProjects.projectKey, projectKey(chemin)),
        ),
      );
    // UNE ligne, pas deux : c'est le même dossier, donc la même identité.
    expect(lignes).toHaveLength(1);
    const ligne = lignes[0]!;
    expect(ligne.registeredAt).toBeInstanceOf(Date);
    expect(ligne.registeredFrom).toBe('spaces');
    expect(ligne.displayName).toBe('Déjà touché');
    expect(ligne.kind).toBe('documents');
    // Ce qui a été approuvé sur ce dossier reste vrai : même dossier, même preuve.
    expect(ligne.verifyCommands).toEqual([{ command: 'pnpm test', timeoutSeconds: 600 }]);
    expect(ligne.verificationEpoch).toBe(3);
  });
});

describe('listProjectsAction', () => {
  it('ne montre QUE les projets enregistrés, et rien de ce que la ligne n’affiche plus', async () => {
    const { listProjectsAction } = await import('../project-actions.ts');

    // Une ligne de comptabilité pure — elle ne doit apparaître nulle part.
    const comptable = `${terrain.path}/pure-comptabilite`;
    await testDb.insert(codeProjects).values({
      entityId: seed.entityId,
      projectPath: comptable,
      projectKey: projectKey(comptable),
      displayName: 'Ne doit pas sortir',
    });

    // Deux travaux rattachés au projet-x, pour que le compte ne soit pas 0 ou 1
    // par accident.
    const projetX = await ligneDuProjet(`${terrain.path}/projet-x`);
    const dernier = new Date('2026-09-05T10:00:00.000Z');
    await testDb.insert(agentJobs).values([
      {
        entityId: seed.entityId,
        agentId: seed.agentId,
        channel: 'api',
        task: 'travail 1',
        projectId: projetX!.id,
        createdAt: new Date('2026-09-01T10:00:00.000Z'),
      },
      {
        entityId: seed.entityId,
        agentId: seed.agentId,
        channel: 'api',
        task: 'travail 2',
        projectId: projetX!.id,
        createdAt: dernier,
      },
    ]);

    const result = await listProjectsAction();
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const chemins = result.data.map((p) => p.path);
    expect(chemins).toContain(`${terrain.path}/projet-x`);
    expect(chemins).toContain(`${terrain.path}/deja-touche`);
    expect(chemins, 'une ligne de comptabilité n’est pas un projet').not.toContain(comptable);

    const x = result.data.find((p) => p.path === `${terrain.path}/projet-x`);
    expect(x!.name).toBe('Projet X');
    // La date que la ligne affiche est celle de l'ENTRÉE AU REGISTRE.
    expect(x!.registeredAt).toBeInstanceOf(Date);

    // Le nom de l'agent, le compte de travaux et la dernière activité ont
    // quitté la ligne le 19/09 : elle ne les porte plus, et la requête ne les
    // joint plus. Un test qui les lirait encore ferait revenir les jointures.
    expect(x).not.toHaveProperty('agentName');
    expect(x).not.toHaveProperty('jobsCount');
    expect(x).not.toHaveProperty('lastActivityAt');

    // Le plus récemment ajouté d'abord.
    const dates = result.data.map((p) => p.registeredAt.getTime());
    expect([...dates].sort((a, b) => b - a)).toEqual(dates);
  });
});

/** Un projet ENREGISTRÉ posé directement en base — sans passer par le disque. */
async function enregistre(opts: {
  path: string;
  name: string;
  kind?: 'code' | 'documents';
  entityId?: string;
  agentId?: string;
}): Promise<string> {
  const [row] = await testDb
    .insert(codeProjects)
    .values({
      entityId: opts.entityId ?? seed.entityId,
      projectPath: opts.path,
      projectKey: projectKey(opts.path),
      displayName: opts.name,
      kind: opts.kind ?? 'code',
      agentId: opts.agentId ?? seed.agentId,
      registeredAt: new Date(),
      registeredFrom: 'spaces',
    })
    .returning({ id: codeProjects.id });
  return row!.id;
}

/** Une commande de preuve, telle que le moteur l'écrit. Rend son `sequence_id`. */
async function preuve(
  cle: string,
  verdict: 'green' | 'red',
  at: Date,
  command = 'pnpm test',
): Promise<string> {
  const sequenceId = randomUUID();
  await testDb.insert(verificationRuns).values({
    entityId: seed.entityId,
    deliverableType: 'code_project',
    canonicalKey: cle,
    sequenceId,
    commandRank: 0,
    command,
    exitCode: verdict === 'green' ? 0 : 1,
    outcomeKind: 'exit',
    verdict,
    createdAt: at,
  });
  return sequenceId;
}

describe('listProjectsAction — l’état de la preuve', () => {
  it('rend le verdict de la vérification la plus RÉCENTE, jamais la première venue', async () => {
    const { listProjectsAction } = await import('../project-actions.ts');
    const chemin = `${terrain.path}/projet-x`;
    const sansPreuve = `${terrain.path}/sans-preuve`;
    await enregistre({ path: sansPreuve, name: 'Sans preuve' });

    // Écrites dans le DÉSORDRE : la plus récente est insérée en premier, pour
    // qu'un tri absent ne puisse pas passer par chance.
    await preuve(projectKey(chemin), 'red', new Date('2026-09-04T10:00:00.000Z'));
    await preuve(projectKey(chemin), 'green', new Date('2026-09-01T10:00:00.000Z'));

    const result = await listProjectsAction();
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const x = result.data.find((p) => p.path === chemin);
    expect(x!.lastProof).toEqual({
      verdict: 'fail',
      at: new Date('2026-09-04T10:00:00.000Z'),
    });

    // Aucune preuve n'a tourné : `null`, jamais un vert par défaut.
    const neuf = result.data.find((p) => p.path === sansPreuve);
    expect(neuf!.lastProof).toBeNull();
  });
});

describe('getProjectPageAction', () => {
  it('liste le dossier sur UN niveau : dossiers d’abord, tailles relues, ignorés comptés', async () => {
    const { getProjectPageAction } = await import('../project-actions.ts');
    const chemin = `${racine.replace(/\\/g, '/')}/etagere`;
    await mkdir(join(chemin, 'zeta-dossier'), { recursive: true });
    await mkdir(join(chemin, 'alpha-dossier'), { recursive: true });
    await mkdir(join(chemin, 'node_modules'), { recursive: true });
    await mkdir(join(chemin, '.git'), { recursive: true });
    await writeFile(join(chemin, 'b.md'), 'bbbbb'); // 5 octets
    await writeFile(join(chemin, 'a.txt'), 'aaa'); // 3 octets
    await writeFile(join(chemin, '.env.example'), 'K=1'); // caché, mais pas ignoré
    // Une JONCTION vers un dossier : ni un dossier du projet, ni un fichier.
    await symlink(join(chemin, 'alpha-dossier'), join(chemin, 'lien-dossier'), 'junction');
    const id = await enregistre({ path: chemin, name: 'Étagère' });

    const result = await getProjectPageAction(id);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.data.files.unreadable).toBeNull();
    // Les dossiers d'abord, puis les liens, puis les fichiers, chacun par nom.
    expect(result.data.files.entries.map((e) => e.name)).toEqual([
      'alpha-dossier',
      'zeta-dossier',
      'lien-dossier',
      '.env.example',
      'a.txt',
      'b.md',
    ]);
    expect(result.data.files.entries.map((e) => e.kind)).toEqual([
      'dir',
      'dir',
      'symlink',
      'file',
      'file',
      'file',
    ]);
    // Les tailles viennent du disque, pas d'un compte de caractères supposé.
    const parNom = new Map(result.data.files.entries.map((e) => [e.name, e.bytes]));
    expect(parNom.get('a.txt')).toBe(3);
    expect(parNom.get('b.md')).toBe(5);
    expect(parNom.get('alpha-dossier')).toBeNull();
    // Un lien n'est JAMAIS mesuré : `stat` le suivrait et rendrait la taille de
    // sa cible, qui peut vivre hors du projet.
    expect(parNom.get('lien-dossier')).toBeNull();
    // `.git` et `node_modules` : comptés, pas escamotés.
    expect(result.data.files.ignored).toBe(2);
    expect(result.data.files.more).toBe(0);
  });

  it('au-delà du plafond, le reste est COMPTÉ', async () => {
    const { getProjectPageAction } = await import('../project-actions.ts');
    const chemin = `${racine.replace(/\\/g, '/')}/plein`;
    await mkdir(chemin, { recursive: true });
    // 205 entrées : 200 montrées, 5 dites.
    for (let i = 0; i < 205; i += 1) {
      await writeFile(join(chemin, `f${String(i).padStart(3, '0')}.txt`), 'x');
    }
    const id = await enregistre({ path: chemin, name: 'Plein' });

    const result = await getProjectPageAction(id);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.files.entries).toHaveLength(200);
    expect(result.data.files.more).toBe(5);
    expect(result.data.files.entries[0]!.name).toBe('f000.txt');
  });

  it('un dossier absent est DIT, pas dessiné comme un projet vide', async () => {
    const { getProjectPageAction } = await import('../project-actions.ts');
    const id = await enregistre({
      path: `${racine.replace(/\\/g, '/')}/jamais-cree`,
      name: 'Fantôme',
    });

    const result = await getProjectPageAction(id);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.files.unreadable).toBe('absent');
    expect(result.data.files.entries).toEqual([]);
  });

  it('un chemin qui est un FICHIER ne se confond pas avec un dossier supprimé', async () => {
    const { getProjectPageAction } = await import('../project-actions.ts');
    const chemin = `${racine.replace(/\\/g, '/')}/pas-un-dossier`;
    await writeFile(chemin, 'je suis un fichier');
    const id = await enregistre({ path: chemin, name: 'Pas un dossier' });

    const result = await getProjectPageAction(id);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // La CAUSE, pas un « missing » qui ferait chercher une suppression.
    expect(result.data.files.unreadable).toBe('not_a_directory');
    expect(result.data.files.entries).toEqual([]);
  });

  it('la preuve du projet : ses séquences et son état d’approbation', async () => {
    const { getProjectPageAction } = await import('../project-actions.ts');
    const chemin = `${terrain.path}/projet-preuve`;
    const id = await enregistre({ path: chemin, name: 'Projet preuve' });
    await testDb
      .update(codeProjects)
      .set({ verifyCommands: [{ command: 'pnpm test', timeoutSeconds: 600 }] })
      .where(eq(codeProjects.id, id));
    await preuve(projectKey(chemin), 'red', new Date('2026-09-03T10:00:00.000Z'));
    // La preuve d'un AUTRE dossier ne doit pas remonter ici.
    await preuve(projectKey(`${terrain.path}/projet-x`), 'green', new Date('2026-09-03T11:00:00Z'));

    const result = await getProjectPageAction(id);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.proof.configured).toBe(true);
    expect(result.data.proof.commands).toEqual([{ command: 'pnpm test', timeoutSeconds: 600 }]);
    // Des commandes, aucune approbation : en attente, jamais « approuvé ».
    expect(result.data.proof.approval).toBe('pending_approval');
    expect(result.data.proof.sequences).toHaveLength(1);
    expect(result.data.proof.sequences[0]!.verdict).toBe('red');
    expect(result.data.proof.sequences[0]!.runs[0]!.command).toBe('pnpm test');
  });

  it('six séquences en base, TROIS rendues : les trois dernières à AVOIR TOURNÉ', async () => {
    const { getProjectPageAction } = await import('../project-actions.ts');
    const chemin = `${terrain.path}/projet-historique`;
    const id = await enregistre({ path: chemin, name: 'Projet historique' });
    const cle = projectKey(chemin);

    // Cinq séquences d'une commande, insérées dans le DÉSORDRE : un tri absent
    // ne doit pas pouvoir passer par chance.
    const sequences: Array<{ jour: number; sequenceId: string }> = [];
    for (const jour of [1, 5, 3, 2, 4]) {
      const sequenceId = await preuve(
        cle,
        'green',
        new Date(`2026-09-0${jour}T10:00:00.000Z`),
        `commande-jour-${jour}`,
      );
      sequences.push({ jour, sequenceId });
    }

    // Et une séquence LONGUE : commencée avant toutes les autres, finie après.
    // C'est elle qui sépare « les trois dernières à avoir tourné » (la requête
    // bornée, qui trie sur la DERNIÈRE commande) de « les trois dernières
    // commencées » (ce que donnait le découpage après coup).
    const longue = randomUUID();
    await testDb.insert(verificationRuns).values([
      {
        entityId: seed.entityId,
        deliverableType: 'code_project',
        canonicalKey: cle,
        sequenceId: longue,
        commandRank: 0,
        command: 'commande-longue-debut',
        exitCode: 0,
        outcomeKind: 'exit',
        verdict: 'green',
        createdAt: new Date('2026-08-30T10:00:00.000Z'),
      },
      {
        entityId: seed.entityId,
        deliverableType: 'code_project',
        canonicalKey: cle,
        sequenceId: longue,
        commandRank: 1,
        command: 'commande-longue-fin',
        exitCode: 0,
        outcomeKind: 'exit',
        verdict: 'green',
        createdAt: new Date('2026-09-06T10:00:00.000Z'),
      },
    ]);

    const result = await getProjectPageAction(id);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.data.proof.sequences).toHaveLength(3);
    const rendues = new Set(result.data.proof.sequences.map((s) => s.sequenceId));
    // La longue est DEDANS : sa dernière commande est la plus récente de toutes.
    expect(rendues.has(longue), 'la séquence longue a tourné en dernier').toBe(true);
    // Les jours 4 et 5 aussi ; les jours 1, 2 et 3 sont dehors.
    for (const jour of [4, 5]) {
      expect(rendues.has(sequences.find((x) => x.jour === jour)!.sequenceId), `jour ${jour}`).toBe(
        true,
      );
    }
    for (const jour of [1, 2, 3]) {
      expect(rendues.has(sequences.find((x) => x.jour === jour)!.sequenceId), `jour ${jour}`).toBe(
        false,
      );
    }
  });

  it('les conversations du projet : celles de ses travaux, et celles qui y sont ancrées', async () => {
    const { getProjectPageAction } = await import('../project-actions.ts');
    const chemin = `${terrain.path}/projet-conv`;
    const id = await enregistre({ path: chemin, name: 'Projet conv' });

    const [depuisTelegram] = await testDb
      .insert(conversations)
      .values({
        entityId: seed.entityId,
        agentId: seed.agentId,
        channel: 'telegram',
        chatId: '4242',
        title: 'Depuis Telegram',
        updatedAt: new Date('2026-09-02T10:00:00.000Z'),
      })
      .returning({ id: conversations.id });
    await testDb.insert(agentJobs).values({
      entityId: seed.entityId,
      agentId: seed.agentId,
      channel: 'telegram',
      task: 'range le dossier',
      projectId: id,
      conversationId: depuisTelegram!.id,
    });

    const [ancienneAncree] = await testDb
      .insert(conversations)
      .values({
        entityId: seed.entityId,
        agentId: seed.agentId,
        channel: 'dashboard',
        title: 'Ancienne',
        currentProjectId: id,
        updatedAt: new Date('2026-09-01T10:00:00.000Z'),
      })
      .returning({ id: conversations.id });
    const [recenteAncree] = await testDb
      .insert(conversations)
      .values({
        entityId: seed.entityId,
        agentId: seed.agentId,
        channel: 'dashboard',
        title: 'Récente',
        currentProjectId: id,
        updatedAt: new Date('2026-09-05T10:00:00.000Z'),
      })
      .returning({ id: conversations.id });

    const [etrangere] = await testDb
      .insert(conversations)
      .values({
        entityId: seed.entityId,
        agentId: seed.agentId,
        channel: 'dashboard',
        title: 'Rien à voir',
        updatedAt: new Date('2026-09-06T10:00:00.000Z'),
      })
      .returning({ id: conversations.id });

    const result = await getProjectPageAction(id);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const ids = result.data.conversations.map((c) => c.id);
    expect(ids).toContain(depuisTelegram!.id);
    expect(ids).toContain(ancienneAncree!.id);
    expect(ids).toContain(recenteAncree!.id);
    expect(ids, 'une conversation sans lien au projet n’est pas la sienne').not.toContain(
      etrangere!.id,
    );

    const parId = new Map(result.data.conversations.map((c) => [c.id, c]));
    // Un travail rattaché suffit à faire lister la conversation, sans l'ancrer.
    expect(parId.get(depuisTelegram!.id)!.anchored).toBe(false);
    expect(parId.get(depuisTelegram!.id)!.channel).toBe('telegram');
    expect(parId.get(depuisTelegram!.id)!.title).toBe('Depuis Telegram');
    expect(parId.get(depuisTelegram!.id)!.agentName).toBe('Test Agent');
    expect(parId.get(recenteAncree!.id)!.anchored).toBe(true);
    // Les plus récentes d'abord.
    expect(ids[0]).toBe(recenteAncree!.id);

    // Ancrées, mais aucune n'a été OUVERTE depuis le projet : la saisie du bas
    // n'a rien à prolonger, et le premier envoi créera le fil.
    expect(result.data.projectConversationId).toBeNull();

    // Et les travaux comptés au passage.
    expect(result.data.project.jobsCount).toBe(1);
    expect(result.data.project.name).toBe('Projet conv');
    expect(result.data.project.agentName).toBe('Test Agent');
  });

  it('la conversation DU projet est celle qu’on a ouverte depuis lui, pas la plus récente ancrée', async () => {
    const { getProjectPageAction } = await import('../project-actions.ts');
    const chemin = `${terrain.path}/projet-origine`;
    const id = await enregistre({ path: chemin, name: 'Projet origine' });

    // Ouverte depuis la page du projet, il y a longtemps.
    const [ouverteDepuisLeProjet] = await testDb
      .insert(conversations)
      .values({
        entityId: seed.entityId,
        agentId: seed.agentId,
        channel: 'dashboard',
        origin: 'project',
        title: 'Projet origine',
        currentProjectId: id,
        updatedAt: new Date('2026-09-01T10:00:00.000Z'),
      })
      .returning({ id: conversations.id });

    // Ancrée bien PLUS TARD, parce qu'une production y a atterri. Sous
    // l'ancienne règle (la plus récente ancrée), c'est elle qui gagnait, et la
    // saisie du bas changeait de fil toute seule.
    const [ancreeParUneProduction] = await testDb
      .insert(conversations)
      .values({
        entityId: seed.entityId,
        agentId: seed.agentId,
        channel: 'dashboard',
        origin: 'user',
        title: 'Ailleurs, puis ici',
        currentProjectId: id,
        updatedAt: new Date('2026-09-06T10:00:00.000Z'),
      })
      .returning({ id: conversations.id });

    const result = await getProjectPageAction(id);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.data.projectConversationId).toBe(ouverteDepuisLeProjet!.id);
    // L'autre reste listée sur la page : elle parle bien de ce projet.
    expect(result.data.conversations.map((c) => c.id)).toContain(ancreeParUneProduction!.id);
  });

  it('le projet d’une AUTRE entité n’existe pas ici', async () => {
    const { getProjectPageAction } = await import('../project-actions.ts');
    const id = await enregistre({
      path: `${voisin.path}/chez-lui`,
      name: 'Chez le voisin',
      entityId: voisin.entityId,
      agentId: voisin.agentId,
    });

    const result = await getProjectPageAction(id);
    expect(result).toEqual({ ok: false, code: 'not_found', message: 'Project not found' });
  });

  it('une ligne de COMPTABILITÉ n’a pas de page', async () => {
    const { getProjectPageAction } = await import('../project-actions.ts');
    const chemin = `${terrain.path}/juste-comptable`;
    const [row] = await testDb
      .insert(codeProjects)
      .values({
        entityId: seed.entityId,
        projectPath: chemin,
        projectKey: projectKey(chemin),
      })
      .returning({ id: codeProjects.id });

    const result = await getProjectPageAction(row!.id);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('not_found');
  });
});

describe('createProjectConversationAction', () => {
  it('sans agent ROOT désigné, elle refuse plutôt que de choisir à la place', async () => {
    const { createProjectConversationAction } = await import('../project-actions.ts');
    const id = await enregistre({ path: `${terrain.path}/sans-root`, name: 'Sans root' });

    const result = await createProjectConversationAction(id);
    expect(result).toEqual({
      ok: false,
      code: 'no_root_agent',
      message:
        'No ROOT agent yet. Create an orchestrator agent first: the first one you create becomes this workspace’s ROOT.',
    });
  });

  it('crée une conversation ancrée au projet — la ligne relue le dit', async () => {
    const { createProjectConversationAction, getProjectPageAction } =
      await import('../project-actions.ts');
    await testDb
      .update(entities)
      .set({ rootAgentId: seed.agentId })
      .where(eq(entities.id, seed.entityId));
    const id = await enregistre({ path: `${terrain.path}/avec-root`, name: 'Avec root' });

    const result = await createProjectConversationAction(id);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const [ligne] = await testDb
      .select()
      .from(conversations)
      .where(eq(conversations.id, result.data.id));
    expect(ligne).toBeDefined();
    expect(ligne!.channel).toBe('dashboard');
    // `project` : c'est cette origine qui désigne le fil que la page prolonge.
    expect(ligne!.origin).toBe('project');
    expect(ligne!.currentProjectId).toBe(id);
    expect(ligne!.title).toBe('Avec root');
    expect(ligne!.agentId).toBe(seed.agentId);

    // Et la page la reconnaît comme LA conversation du projet.
    const page = await getProjectPageAction(id);
    expect(page.ok).toBe(true);
    if (!page.ok) return;
    expect(page.data.projectConversationId).toBe(result.data.id);
  });
});

// ─── #143 : INSCRIRE un dossier détecté ──────────────────────────────────────
//
// Le geste que l'onglet Code n'avait pas. Ce qui compte ici est la LIGNE
// écrite — `registered_at` posé, le responsable, l'origine — et la garde qui
// refuse un chemin hors des dossiers de l'espace : sans elle, n'importe quel
// chemin de la machine entrerait au registre, donc dans le contexte injecté
// aux agents comme endroit où ils peuvent écrire.
describe('registerDetectedProjectAction @cap:travailler-sur-des-fichiers/moteur', () => {
  it('refuse un chemin HORS des dossiers de l’espace, et n’écrit rien', async () => {
    const { registerDetectedProjectAction } = await import('../project-actions.ts');
    const dehors = join(racine, 'pas-un-terrain', 'app').replace(/\\/g, '/');

    const result = await registerDetectedProjectAction({ projectPath: dehors, agentId: null });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('not_in_workspace');
    expect(await ligneDuProjet(dehors)).toBeNull();
  });

  it('refuse le dossier d’un AUTRE espace', async () => {
    const { registerDetectedProjectAction } = await import('../project-actions.ts');
    const chezLeVoisin = `${voisin.path}/leur-app`;

    const result = await registerDetectedProjectAction({
      projectPath: chezLeVoisin,
      agentId: voisin.agentId,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('not_in_workspace');
    expect(await ligneDuProjet(chezLeVoisin)).toBeNull();
  });

  it('refuse un chemin qui SORT du terrain par `..`, même s’il commence par lui', async () => {
    // Revue Reviewer C, passe 1. `normalizePath` n'aplatit pas `..` et
    // `isUnderPath` compare du texte : `<terrain>/../evade` commence bien par
    // `<terrain>/` et passait pour un enfant. Le dossier entrait au registre,
    // donc dans la liste des endroits où les agents peuvent écrire, HORS de
    // tout terrain.
    const { registerDetectedProjectAction } = await import('../project-actions.ts');
    const evade = join(racine, 'evade').replace(/\\/g, '/');
    await mkdir(evade, { recursive: true });
    const parLeHaut = `${terrain.path}/../evade`;

    const result = await registerDetectedProjectAction({ projectPath: parLeHaut, agentId: null });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('not_in_workspace');
    // Ni sous la forme reçue, ni sous la forme résolue.
    expect(await ligneDuProjet(parLeHaut)).toBeNull();
    expect(await ligneDuProjet(evade)).toBeNull();
  });

  it('refuse un LIEN posé dans le terrain qui pointe dehors', async () => {
    // Le texte du chemin est dans le terrain, le disque non. Sans la garde
    // physique, les agents se verraient offrir un chemin qui écrit ailleurs.
    // Une jonction de dossier se crée sans droit particulier, sur Windows
    // comme ailleurs.
    const { registerDetectedProjectAction } = await import('../project-actions.ts');
    const dehors = join(racine, 'cible-hors-terrain').replace(/\\/g, '/');
    await mkdir(dehors, { recursive: true });
    await mkdir(terrain.path, { recursive: true });
    const lien = `${terrain.path}/lien-sortant`;
    await symlink(dehors, lien, 'junction');

    const result = await registerDetectedProjectAction({ projectPath: lien, agentId: null });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('not_in_workspace');
    expect(await ligneDuProjet(lien)).toBeNull();
    expect(await ligneDuProjet(dehors)).toBeNull();
  });

  it('STOCKE le chemin demandé, jamais le chemin résolu', async () => {
    // Le constat de la CI Windows (19/09) : `realpath` détend un nom court 8.3
    // (`C:/Users/RUNNER~1/…` → `C:/Users/runneradmin/…`), donc écrire le chemin
    // résolu donne une CLÉ que la détection ne produit jamais — le projet
    // resterait « Detected » et son masquage ne serait plus retrouvé. Prouvé
    // ici par un lien INTERNE, qui fait diverger les deux formes sur n'importe
    // quel système.
    const { registerDetectedProjectAction } = await import('../project-actions.ts');
    const cible = `${terrain.path}/cible-interne`;
    await mkdir(cible, { recursive: true });
    const alias = `${terrain.path}/alias-interne`;
    await symlink(cible, alias, 'junction');

    const result = await registerDetectedProjectAction({ projectPath: alias, agentId: null });
    expect(result.ok, result.ok ? '' : result.message).toBe(true);
    if (!result.ok) return;
    expect(result.data.path).toBe(alias);

    const ligne = await ligneDuProjet(alias);
    expect(ligne!.projectPath).toBe(alias);
    expect(ligne!.projectKey).toBe(projectKey(alias));
    // Et RIEN sous le nom de la cible : une seconde identité pour le même
    // dossier est exactement ce qu'on évite.
    expect(await ligneDuProjet(cible)).toBeNull();
  });

  it('refuse un dossier qui n’existe PAS : un projet fantôme ne s’inscrit pas', async () => {
    const { registerDetectedProjectAction } = await import('../project-actions.ts');
    const disparu = `${terrain.path}/jamais-cree`;

    const result = await registerDetectedProjectAction({ projectPath: disparu, agentId: null });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('folder_missing');
    expect(await ligneDuProjet(disparu)).toBeNull();
  });

  it('un `.` et des antislashs désignent le MÊME dossier : une seule ligne, chemin canonique', async () => {
    // Le second défaut de la forme brute : `<terrain>/./app` a une CLÉ
    // différente de `<terrain>/app`, donc une seconde ligne de registre pour
    // le même dossier, que rien n'aurait rapprochée.
    const { registerDetectedProjectAction } = await import('../project-actions.ts');
    const canonique = `${terrain.path}/canonique`;
    await mkdir(canonique, { recursive: true });

    const premier = await registerDetectedProjectAction({
      projectPath: `${terrain.path}/./canonique`,
      agentId: null,
    });
    expect(premier.ok, premier.ok ? '' : premier.message).toBe(true);
    if (!premier.ok) return;
    // Le chemin STOCKÉ est le chemin réel, pas la forme reçue.
    expect(premier.data.path).toBe(canonique);
    const ligne = await ligneDuProjet(canonique);
    expect(ligne!.projectPath).toBe(canonique);

    // La même demande écrite autrement ne crée PAS de seconde ligne.
    const second = await registerDetectedProjectAction({
      projectPath: `${terrain.path.replace(/\//g, '\\')}\\canonique`,
      agentId: null,
    });
    expect(second.ok, second.ok ? '' : second.message).toBe(true);
    if (!second.ok) return;
    expect(second.data.id).toBe(premier.data.id);

    const toutes = await testDb
      .select({ id: codeProjects.id })
      .from(codeProjects)
      .where(
        and(
          eq(codeProjects.entityId, seed.entityId),
          eq(codeProjects.projectKey, projectKey(canonique)),
        ),
      );
    expect(toutes).toHaveLength(1);
  });

  it('ÉCRIT la ligne du registre : enregistrée, de sorte « code », avec son responsable', async () => {
    const { registerDetectedProjectAction, listProjectsAction } =
      await import('../project-actions.ts');
    const detecte = `${terrain.path}/detecte-app`;
    // Le dossier EXISTE : la détection ne remonte que des dossiers où quelque
    // chose a été écrit, et le registre refuse un projet fantôme.
    await mkdir(detecte, { recursive: true });

    const avant = new Date();
    const result = await registerDetectedProjectAction({ projectPath: detecte, agentId: null });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const ligne = await ligneDuProjet(detecte);
    expect(ligne, 'aucune ligne écrite pour le dossier inscrit').toBeTruthy();
    expect(ligne!.id).toBe(result.data.id);
    expect(ligne!.projectPath).toBe(detecte);
    expect(ligne!.kind).toBe('code');
    expect(ligne!.registeredFrom).toBe('spaces');
    // `registered_at` est LE discriminant du registre : sans lui, la ligne
    // resterait une ligne de comptabilité et le projet n'aurait pas de page.
    expect(ligne!.registeredAt).toBeTruthy();
    expect(ligne!.registeredAt!.getTime()).toBeGreaterThanOrEqual(avant.getTime() - 1000);
    // Le détenteur UNIQUE du terrain devient le responsable.
    expect(ligne!.agentId).toBe(seed.agentId);

    // Et le registre le liste — c'est ce que l'écran relira.
    const liste = await listProjectsAction();
    expect(liste.ok).toBe(true);
    if (!liste.ok) return;
    expect(liste.data.some((p) => p.id === ligne!.id)).toBe(true);
  });

  it('un projet DÉJÀ inscrit n’est pas réinscrit : sa date d’ajout et son nom restent', async () => {
    const { registerDetectedProjectAction } = await import('../project-actions.ts');
    const dejaLa = `${terrain.path}/deja-inscrit`;
    await mkdir(dejaLa, { recursive: true });
    const ancienne = new Date('2026-09-01T10:00:00.000Z');
    await testDb.insert(codeProjects).values({
      entityId: seed.entityId,
      projectPath: dejaLa,
      projectKey: projectKey(dejaLa),
      kind: 'code',
      displayName: 'Le nom que j’ai choisi',
      registeredAt: ancienne,
      registeredFrom: 'conversation',
    });

    const result = await registerDetectedProjectAction({ projectPath: dejaLa, agentId: null });
    // Le second clic mène au projet, jamais à une erreur.
    expect(result.ok).toBe(true);

    const ligne = await ligneDuProjet(dejaLa);
    expect(ligne!.registeredAt!.toISOString()).toBe(ancienne.toISOString());
    expect(ligne!.registeredFrom).toBe('conversation');
    expect(ligne!.displayName).toBe('Le nom que j’ai choisi');
  });

  it('une ligne de COMPTABILITÉ (renommée, masquée) devient un projet sans perdre ses gestes', async () => {
    const { registerDetectedProjectAction } = await import('../project-actions.ts');
    const range = `${terrain.path}/range-puis-inscrit`;
    await mkdir(range, { recursive: true });
    await testDb.insert(codeProjects).values({
      entityId: seed.entityId,
      projectPath: range,
      projectKey: projectKey(range),
      displayName: 'Portail client',
      hidden: true,
      // Pas de `registered_at` : c'est une ligne de comptabilité.
    });

    const result = await registerDetectedProjectAction({ projectPath: range, agentId: null });
    expect(result.ok).toBe(true);

    const ligne = await ligneDuProjet(range);
    expect(ligne!.registeredAt, 'la ligne n’a pas été inscrite au registre').toBeTruthy();
    // Les deux gestes du propriétaire survivent à l'inscription : ranger un
    // projet n'est pas le désinscrire, et le renommer n'est pas le perdre.
    expect(ligne!.displayName).toBe('Portail client');
    expect(ligne!.hidden).toBe(true);
  });
});

// ─── #143 : l'ACTIVITÉ d'un projet ───────────────────────────────────────────
//
// Une liste à l'écran, deux lectures ici. Ce qui compte : une session SANS
// conversation ne disparaît pas avec la liste Code, et une conversation dit
// combien de sessions sont parties d'elle.
describe('getProjectActivityAction @cap:travailler-sur-des-fichiers/moteur', () => {
  it('rend les conversations ET les runs sans conversation, chacun dans sa liste', async () => {
    const { getProjectActivityAction } = await import('../project-actions.ts');
    const chemin = `${terrain.path}/activite`;
    const projectId = await enregistre({ path: chemin, name: 'Activity project' });

    // Une conversation ancrée, avec DEUX runs à elle.
    const [conv] = await testDb
      .insert(conversations)
      .values({
        entityId: seed.entityId,
        agentId: seed.agentId,
        channel: 'dashboard',
        origin: 'project',
        title: 'Fix the release check',
        currentProjectId: projectId,
        updatedAt: new Date('2026-09-19T14:02:00.000Z'),
      })
      .returning({ id: conversations.id });
    for (const i of [0, 1]) {
      await testDb.insert(agentJobs).values({
        entityId: seed.entityId,
        agentId: seed.agentId,
        projectId,
        conversationId: conv!.id,
        channel: 'dashboard',
        status: i === 0 ? 'completed' : 'processing',
        task: `tour ${i}`,
      });
    }

    // Un run SANS conversation — celui que l'onglet Code listait.
    const [solo] = await testDb
      .insert(agentJobs)
      .values({
        entityId: seed.entityId,
        agentId: seed.agentId,
        projectId,
        channel: 'mcp',
        status: 'awaiting_approval',
        task: 'approval needed to write 3 files',
      })
      .returning({ id: agentJobs.id });

    const result = await getProjectActivityAction(projectId);
    expect(result.ok, result.ok ? '' : result.message).toBe(true);
    if (!result.ok) return;

    expect(result.data.conversations).toHaveLength(1);
    const fil = result.data.conversations[0]!;
    expect(fil.id).toBe(conv!.id);
    expect(fil.title).toBe('Fix the release check');
    // « N sessions inside » : les runs DU PROJET portés par ce fil.
    expect(fil.sessions).toBe(2);
    // L'un d'eux avance encore.
    expect(fil.running).toBe(true);

    expect(result.data.sessions.map((s) => s.id)).toEqual([solo!.id]);
    const session = result.data.sessions[0]!;
    expect(session.origin).toBe('mcp');
    expect(session.status).toBe('awaiting_approval');
    expect(session.task).toBe('approval needed to write 3 files');
    // Aucune ligne `cli_runs` : le harnais est INCONNU, pas deviné.
    expect(session.provider).toBeNull();
  });

  it('un run DÉLÉGUÉ n’est pas une ligne : c’est le run de tête qui en porte une', async () => {
    const { getProjectActivityAction } = await import('../project-actions.ts');
    const chemin = `${terrain.path}/activite-delegation`;
    const projectId = await enregistre({ path: chemin, name: 'Activity project' });

    const [tete] = await testDb
      .insert(agentJobs)
      .values({
        entityId: seed.entityId,
        agentId: seed.agentId,
        projectId,
        channel: 'mcp',
        status: 'awaiting_delegation',
        task: 'build it',
      })
      .returning({ id: agentJobs.id });
    await testDb.insert(agentJobs).values({
      entityId: seed.entityId,
      agentId: seed.agentId,
      projectId,
      parentJobId: tete!.id,
      channel: 'internal',
      status: 'processing',
      task: 'the delegated half',
    });

    const result = await getProjectActivityAction(projectId);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.sessions.map((s) => s.id)).toEqual([tete!.id]);
  });

  it('refuse une ligne de COMPTABILITÉ : ce n’est pas un projet, elle n’a pas de page', async () => {
    const { getProjectActivityAction } = await import('../project-actions.ts');
    const chemin = `${terrain.path}/comptabilite-activite`;
    const [ligne] = await testDb
      .insert(codeProjects)
      .values({
        entityId: seed.entityId,
        projectPath: chemin,
        projectKey: projectKey(chemin),
        hidden: true,
      })
      .returning({ id: codeProjects.id });

    const result = await getProjectActivityAction(ligne!.id);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('not_found');
  });
});

describe('getProjectFactsAction @cap:travailler-sur-des-fichiers/moteur', () => {
  it('compte les conversations et les sessions, et lit `.git` SUR LE DISQUE', async () => {
    const { getProjectFactsAction } = await import('../project-actions.ts');
    const chemin = `${terrain.path}/faits`;
    const projectId = await enregistre({ path: chemin, name: 'Activity project' });
    await mkdir(`${chemin}/.git`, { recursive: true });

    const [conv] = await testDb
      .insert(conversations)
      .values({
        entityId: seed.entityId,
        agentId: seed.agentId,
        channel: 'dashboard',
        origin: 'project',
        title: 'Un fil',
        currentProjectId: projectId,
      })
      .returning({ id: conversations.id });
    await testDb.insert(agentJobs).values({
      entityId: seed.entityId,
      agentId: seed.agentId,
      projectId,
      conversationId: conv!.id,
      channel: 'dashboard',
      status: 'completed',
      task: 'un tour',
    });

    const result = await getProjectFactsAction(projectId);
    expect(result.ok, result.ok ? '' : result.message).toBe(true);
    if (!result.ok) return;
    expect(result.data.conversations).toBe(1);
    expect(result.data.sessions).toBe(1);
    expect(result.data.isGitRepository).toBe(true);
  });

  it('compte TOUS les runs de tête du projet, portés par un fil ou non', async () => {
    const { getProjectFactsAction } = await import('../project-actions.ts');
    const chemin = `${terrain.path}/faits-compteur`;
    const projectId = await enregistre({ path: chemin, name: 'Compteur' });

    const [conv] = await testDb
      .insert(conversations)
      .values({
        entityId: seed.entityId,
        agentId: seed.agentId,
        channel: 'dashboard',
        origin: 'project',
        title: 'Un fil',
        currentProjectId: projectId,
      })
      .returning({ id: conversations.id });
    await testDb.insert(agentJobs).values([
      {
        entityId: seed.entityId,
        agentId: seed.agentId,
        projectId,
        conversationId: conv!.id,
        channel: 'dashboard',
        status: 'completed',
        task: 'porté par le fil',
      },
      {
        entityId: seed.entityId,
        agentId: seed.agentId,
        projectId,
        channel: 'mcp',
        status: 'completed',
        task: 'tout seul',
      },
    ]);

    const result = await getProjectFactsAction(projectId);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // « 2 sessions » sous le nom du projet : les deux ont tourné dedans, que
    // l'une soit portée par un fil ou non.
    expect(result.data.sessions).toBe(2);
    expect(result.data.conversations).toBe(1);
  });

  it('un dossier SANS `.git` ne se dit pas dépôt, quelle que soit la sorte du projet', async () => {
    const { getProjectFactsAction } = await import('../project-actions.ts');
    const chemin = `${terrain.path}/faits-sans-git`;
    const projectId = await enregistre({ path: chemin, name: 'Activity project' });
    await mkdir(chemin, { recursive: true });

    const result = await getProjectFactsAction(projectId);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.kind).toBe('code');
    expect(result.data.isGitRepository).toBe(false);
    expect(result.data.conversations).toBe(0);
    expect(result.data.sessions).toBe(0);
  });
});

describe('listProofsForPathsAction @cap:verifier-un-livrable/moteur', () => {
  it('rend le DERNIER verdict de chaque chemin, et rien pour un chemin sans preuve', async () => {
    const { listProofsForPathsAction } = await import('../project-actions.ts');
    const prouve = `${terrain.path}/prouve-pour-la-liste`;
    const sansPreuve = `${terrain.path}/sans-preuve`;

    await preuve(projectKey(prouve), 'red', new Date('2026-09-10T10:00:00.000Z'));
    await preuve(projectKey(prouve), 'green', new Date('2026-09-11T10:00:00.000Z'));

    const result = await listProofsForPathsAction([prouve, sansPreuve]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const lu = result.data.filter((p) => p.key === projectKey(prouve));
    expect(lu).toHaveLength(1);
    // Le plus RÉCENT gagne : le rouge de la veille ne décrit plus rien.
    expect(lu[0]!.verdict).toBe('pass');
    expect(result.data.some((p) => p.key === projectKey(sansPreuve))).toBe(false);
  });
});

describe('listProjectTerrainsAction', () => {
  it('rend les agents de l’entité avec leurs dossiers, et personne d’autre', async () => {
    const { listProjectTerrainsAction } = await import('../project-actions.ts');

    const result = await listProjectTerrainsAction();
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.data.map((t) => t.agentId)).toEqual([seed.agentId]);
    const terrains = result.data[0]!.workspaces;
    expect(terrains.map((w) => w.path)).toEqual([terrain.path]);
    expect(terrains[0]!.label).toBe('terrain');
    expect(terrains[0]!.id).toBe(terrain.workspaceId);
  });
});
