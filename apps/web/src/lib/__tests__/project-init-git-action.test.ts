// project-init-git-action.test.ts — L'ACTION QUI POSE GIT, et tout ce qu'elle
// refuse de faire (issue #200, revue C de la PR #244, constat 2).
//
// Ce qui se joue ici n'est pas un réglage : `git init` ÉCRIT dans le dossier de
// quelqu'un. La première version prenait le chemin dans la charge utile et
// partait dessus avant qu'aucune lecture n'ait dit à qui ce dossier
// appartenait — appeler l'action avec le dossier personnel du propriétaire y
// posait un dépôt.
//
// Les assertions portent donc sur LE DISQUE et sur la LIGNE relue, jamais sur
// `result.ok` : un refus qui laisse quand même un `.git` derrière lui n'est pas
// un refus.

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import { and, eq, agentWorkspaces, codeProjects, entities, users } from '@nodal-agents/db';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';

const run = promisify(execFile);

let testDb: TestDb;
let seed: Awaited<ReturnType<typeof seedMinimal>>;
let racine = '';
let terrainId = '';
let terrain = '';
/** Un autre utilisateur — sert à rendre la session NON-propriétaire. */
let voisinUserId = '';
/** Un dossier HORS de tout projet : celui qu'une charge utile hostile viserait. */
let horsRegistre = '';

const norm = (p: string) => p.replace(/\\/g, '/');

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
  const res = await spinUpTestDb();
  testDb = res.db;
  seed = await seedMinimal(testDb);

  racine = norm(await mkdtemp(join(tmpdir(), 'nodal-init-git-')));
  terrain = `${racine}/terrain`;
  await mkdir(terrain, { recursive: true });
  const [ws] = await testDb
    .insert(agentWorkspaces)
    .values({ entityId: seed.entityId, agentId: seed.agentId, label: 'terrain', path: terrain })
    .returning({ id: agentWorkspaces.id });
  terrainId = ws!.id;

  horsRegistre = `${racine}/maison`;
  await mkdir(horsRegistre, { recursive: true });
  await writeFile(`${horsRegistre}/journal-intime.md`, '# rien pour toi\n');

  const [autreUser] = await testDb
    .insert(users)
    .values({ email: `voisin-init-git-${Date.now()}@example.com` })
    .returning();
  voisinUserId = autreUser!.id;
});

afterAll(async () => {
  if (racine) await rm(racine, { recursive: true, force: true });
});

/** Un projet ENREGISTRÉ neuf, avec son dossier. Rend son id et son chemin. */
async function projetNeuf(nom: string): Promise<{ id: string; path: string }> {
  const { createProjectAction } = await import('../project-actions.ts');
  const r = await createProjectAction({
    name: nom,
    agentId: seed.agentId,
    workspaceId: terrainId,
    subfolder: nom,
    kind: 'code',
  });
  if (!r.ok) throw new Error(`création refusée : ${r.message}`);
  return r.data;
}

/** La ligne du projet, relue — l'intention ET le fait. */
async function ligne(id: string) {
  const [row] = await testDb
    .select({ initGit: codeProjects.initGit, gitInitializedAt: codeProjects.gitInitializedAt })
    .from(codeProjects)
    .where(eq(codeProjects.id, id));
  return row ?? null;
}

describe('setCodeProjectInitGitAction @cap:travailler-sur-des-fichiers/moteur', () => {
  it('ON pose le dépôt, et la ligne porte l’intention ET la date', async () => {
    const { setCodeProjectInitGitAction } = await import('../actions.ts');
    const projet = await projetNeuf('pose');

    const r = await setCodeProjectInitGitAction({ projectId: projet.id, initGit: true });

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.outcome).toBe('initialised');
    expect(existsSync(join(projet.path, '.git'))).toBe(true);
    const apres = await ligne(projet.id);
    expect(apres?.initGit).toBe(true);
    expect(apres?.gitInitializedAt).toBeInstanceOf(Date);
  });

  it('ON sur un dossier DÉJÀ dépôt ne retouche rien, et le DIT', async () => {
    const { setCodeProjectInitGitAction } = await import('../actions.ts');
    const projet = await projetNeuf('deja-depot');
    await run('git', ['init'], { cwd: projet.path, windowsHide: true });
    await writeFile(join(projet.path, '.gitignore'), 'le mien\n');

    const r = await setCodeProjectInitGitAction({ projectId: projet.id, initGit: true });

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.outcome).toBe('already');
    // Rien n'a été posé : pas de date inventée, et le `.gitignore` de
    // quelqu'un d'autre n'est pas un défaut à corriger.
    expect(r.data.gitInitializedAt).toBeNull();
    expect((await ligne(projet.id))?.gitInitializedAt).toBeNull();
  });

  it('OFF ne supprime rien, et garde la DATE de pose', async () => {
    const { setCodeProjectInitGitAction } = await import('../actions.ts');
    const projet = await projetNeuf('extinction');
    await setCodeProjectInitGitAction({ projectId: projet.id, initGit: true });
    const pose = (await ligne(projet.id))?.gitInitializedAt;
    expect(pose).toBeInstanceOf(Date);

    const r = await setCodeProjectInitGitAction({ projectId: projet.id, initGit: false });

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.outcome).toBe('off');
    // Le dépôt reste : éteindre un interrupteur n'emporte pas un historique.
    expect(existsSync(join(projet.path, '.git'))).toBe(true);
    const apres = await ligne(projet.id);
    expect(apres?.initGit).toBe(false);
    // La date est un FAIT, pas un réglage : elle survit à l'extinction, et la
    // réponse la rend telle que la ligne la porte (revue C, mineur 6).
    expect(apres?.gitInitializedAt?.getTime()).toBe(pose?.getTime());
    expect(r.data.gitInitializedAt).toBe(pose?.toISOString());
  });

  it('un id HORS REGISTRE ne fait rien : ni ligne, ni dossier touché', async () => {
    const { setCodeProjectInitGitAction } = await import('../actions.ts');

    const r = await setCodeProjectInitGitAction({ projectId: randomUUID(), initGit: true });

    expect(r.ok).toBe(false);
    expect(r.ok ? '' : r.code).toBe('not_found');
    // Et rien n'a été créé sous le terrain : l'action n'a pas de chemin à
    // écrire tant qu'elle n'en a pas lu un.
    expect(existsSync(join(horsRegistre, '.git'))).toBe(false);
  });

  it('un projet d’une AUTRE entité est introuvable, pas « interdit »', async () => {
    // Le dossier existe, la ligne existe, mais pas pour cette session. Dire
    // « interdit » confirmerait son existence ; `not_found` ne dit rien.
    const { setCodeProjectInitGitAction } = await import('../actions.ts');
    const [autreEntite] = await testDb
      .insert(entities)
      .values({ userId: voisinUserId, name: 'Voisin', slug: `voisin-ig-${Date.now()}` })
      .returning();
    const chemin = `${racine}/chez-le-voisin`;
    await mkdir(chemin, { recursive: true });
    const [row] = await testDb
      .insert(codeProjects)
      .values({
        entityId: autreEntite!.id,
        projectPath: chemin,
        projectKey: chemin.toLowerCase(),
        registeredAt: new Date(),
        registeredFrom: 'spaces',
      })
      .returning({ id: codeProjects.id });

    const r = await setCodeProjectInitGitAction({ projectId: row!.id, initGit: true });

    expect(r.ok).toBe(false);
    expect(r.ok ? '' : r.code).toBe('not_found');
    expect(existsSync(join(chemin, '.git'))).toBe(false);
  });

  it('une ligne de COMPTABILITÉ n’est pas un projet : refusée', async () => {
    // `code_projects` porte aussi des lignes nées d'une écriture, sans
    // `registered_at`. Elles désignent un dossier que personne n'a déclaré, et
    // poser un dépôt dedans serait poser un dépôt sur une trace.
    const { setCodeProjectInitGitAction } = await import('../actions.ts');
    const chemin = `${racine}/comptabilite`;
    await mkdir(chemin, { recursive: true });
    const [row] = await testDb
      .insert(codeProjects)
      .values({
        entityId: seed.entityId,
        projectPath: chemin,
        projectKey: chemin.toLowerCase(),
      })
      .returning({ id: codeProjects.id });

    const r = await setCodeProjectInitGitAction({ projectId: row!.id, initGit: true });

    expect(r.ok).toBe(false);
    expect(r.ok ? '' : r.code).toBe('not_found');
    expect(existsSync(join(chemin, '.git'))).toBe(false);
  });

  it('hors PROPRIÉTAIRE, rien n’est posé', async () => {
    const { setCodeProjectInitGitAction } = await import('../actions.ts');
    const projet = await projetNeuf('pas-a-toi');

    await testDb
      .update(entities)
      .set({ userId: voisinUserId })
      .where(eq(entities.id, seed.entityId));
    try {
      const r = await setCodeProjectInitGitAction({ projectId: projet.id, initGit: true });

      expect(r.ok).toBe(false);
      expect(r.ok ? '' : r.code).toBe('forbidden');
      expect(
        existsSync(join(projet.path, '.git')),
        'un non-propriétaire a posé un dépôt dans un dossier partagé',
      ).toBe(false);
      expect((await ligne(projet.id))?.initGit).toBe(false);
    } finally {
      await testDb
        .update(entities)
        .set({ userId: seed.userId })
        .where(eq(entities.id, seed.entityId));
    }
  });

  it('la ligne visée est bien celle de CETTE entité, par son id', async () => {
    // Garde de forme : l'action lit par (id, entité, enregistré). Le test
    // ci-dessus prouve le refus ; celui-ci prouve que la lecture existe telle
    // quelle, pour qu'un futur correctif ne la remplace pas par une lecture
    // par chemin.
    const projet = await projetNeuf('identite');
    const [row] = await testDb
      .select({ id: codeProjects.id })
      .from(codeProjects)
      .where(and(eq(codeProjects.id, projet.id), eq(codeProjects.entityId, seed.entityId)));
    expect(row?.id).toBe(projet.id);
  });
});
