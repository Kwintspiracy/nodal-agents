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
  it('ne montre QUE les projets enregistrés, avec le compte de travaux et la dernière activité', async () => {
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
    expect(x!.agentId).toBe(seed.agentId);
    expect(x!.agentName).toBe('Test Agent');
    expect(x!.jobsCount).toBe(2);
    expect(x!.lastActivityAt?.toISOString()).toBe(dernier.toISOString());

    // Un projet sans travail : compte à zéro, activité nulle — pas une absence.
    const neuf = result.data.find((p) => p.path === `${terrain.path}/deja-touche`);
    expect(neuf!.jobsCount).toBe(0);
    expect(neuf!.lastActivityAt).toBeNull();

    // Le plus actif d'abord.
    expect(result.data[0]!.path).toBe(`${terrain.path}/projet-x`);
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

/** Une commande de preuve, telle que le moteur l'écrit. */
async function preuve(cle: string, verdict: 'green' | 'red', at: Date): Promise<void> {
  await testDb.insert(verificationRuns).values({
    entityId: seed.entityId,
    deliverableType: 'code_project',
    canonicalKey: cle,
    sequenceId: randomUUID(),
    commandRank: 0,
    command: 'pnpm test',
    exitCode: verdict === 'green' ? 0 : 1,
    outcomeKind: 'exit',
    verdict,
    createdAt: at,
  });
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
    const id = await enregistre({ path: chemin, name: 'Étagère' });

    const result = await getProjectPageAction(id);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.data.files.missing).toBe(false);
    // Les dossiers d'abord, puis les fichiers, chacun par nom.
    expect(result.data.files.entries.map((e) => e.name)).toEqual([
      'alpha-dossier',
      'zeta-dossier',
      '.env.example',
      'a.txt',
      'b.md',
    ]);
    expect(result.data.files.entries.map((e) => e.kind)).toEqual([
      'dir',
      'dir',
      'file',
      'file',
      'file',
    ]);
    // Les tailles viennent du disque, pas d'un compte de caractères supposé.
    const parNom = new Map(result.data.files.entries.map((e) => [e.name, e.bytes]));
    expect(parNom.get('a.txt')).toBe(3);
    expect(parNom.get('b.md')).toBe(5);
    expect(parNom.get('alpha-dossier')).toBeNull();
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
    expect(result.data.files.missing).toBe(true);
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

    // La conversation DU projet : la plus récente ancrée du dashboard.
    expect(result.data.projectConversationId).toBe(recenteAncree!.id);

    // Et les travaux comptés au passage.
    expect(result.data.project.jobsCount).toBe(1);
    expect(result.data.project.name).toBe('Projet conv');
    expect(result.data.project.agentName).toBe('Test Agent');
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
      message: 'Designate a ROOT agent in Settings first.',
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
    expect(ligne!.origin).toBe('user');
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
