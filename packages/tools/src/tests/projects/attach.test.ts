// attach.test.ts — le REGISTRE des projets (P5), sur des lignes RELUES.
//
// Ce que ces tests protègent, un par un :
//   - un travail qui tombe dans un projet enregistré le porte ;
//   - un travail hors de tout projet n'en INVENTE aucun (P5 ne crée rien
//     hors registre ; « où écrire ? » est P10) ;
//   - le PREMIER projet gagne, et l'ignoré est nommé plutôt qu'oublié ;
//   - deux projets imbriqués : le plus niché gagne ;
//   - la frontière de segment et la casse Windows, la règle partagée
//     `isWithinRoot` — sans elle, `projet-x` avalerait `projet-x-bis` ;
//   - sans job, rien n'est écrit.
//
// Aucune assertion sur une issue seule : chaque cas relit `agent_jobs` en base.

import { describe, it, expect, beforeAll } from 'vitest';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import { agentJobs, codeProjects, eq, and } from '@nodal-agents/db';
import { projectKey, type MutationTarget } from '@nodal-agents/shared';
import { attachProductionToProject } from '../../projects/attach';

let db: TestDb;
let seed: Awaited<ReturnType<typeof seedMinimal>>;

/** Une racine jetable et STABLE — aucun accès disque ici, le registre est pur base. */
const TERRAIN = '/tmp/nodal-attach/terrain';

beforeAll(async () => {
  const res = await spinUpTestDb();
  db = res.db;
  seed = await seedMinimal(db);
});

/** Un projet ENREGISTRÉ (registered_at posé) — celui auquel on se rattache. */
async function projetEnregistre(path: string, opts?: { hidden?: boolean }): Promise<string> {
  const [row] = await db
    .insert(codeProjects)
    .values({
      entityId: seed.entityId,
      projectPath: path,
      projectKey: projectKey(path),
      displayName: path,
      hidden: opts?.hidden ?? false,
      agentId: seed.agentId,
      registeredAt: new Date(),
      registeredFrom: 'spaces',
    })
    .returning({ id: codeProjects.id });
  if (!row) throw new Error(`insert projet ${path}`);
  return row.id;
}

/** Une ligne de COMPTABILITÉ — celle que l'intention de mutation crée toute seule. */
async function ligneDeComptabilite(path: string): Promise<string> {
  const [row] = await db
    .insert(codeProjects)
    .values({
      entityId: seed.entityId,
      projectPath: path,
      projectKey: projectKey(path),
    })
    .returning({ id: codeProjects.id });
  if (!row) throw new Error(`insert comptabilité ${path}`);
  return row.id;
}

async function jobNeuf(): Promise<string> {
  const [job] = await db
    .insert(agentJobs)
    .values({
      entityId: seed.entityId,
      agentId: seed.agentId,
      channel: 'api',
      task: 'attach',
    })
    .returning({ id: agentJobs.id });
  if (!job) throw new Error('insert job');
  return job.id;
}

async function projetDuJob(jobId: string): Promise<string | null> {
  const [row] = await db
    .select({ projectId: agentJobs.projectId })
    .from(agentJobs)
    .where(eq(agentJobs.id, jobId));
  if (!row) throw new Error('job introuvable');
  return row.projectId;
}

const fichier = (path: string): MutationTarget => ({
  kind: 'file',
  path,
  deliverableType: 'code_project',
});

function ctx(jobId: string | null) {
  return { db, entityId: seed.entityId, jobId };
}

describe('attachProductionToProject', () => {
  it('rattache le job au projet enregistré qui contient la cible', async () => {
    const racine = `${TERRAIN}-1`;
    const projetId = await projetEnregistre(`${racine}/projet-x`);
    const jobId = await jobNeuf();

    const issue = await attachProductionToProject(ctx(jobId), [
      fichier(`${racine}/projet-x/src/a.ts`),
    ]);

    expect(issue).toEqual({
      kind: 'attached',
      projectId: projetId,
      projectPath: `${racine}/projet-x`,
    });
    expect(await projetDuJob(jobId)).toBe(projetId);
  });

  it('hors de tout projet enregistré : rien n’est posé, et RIEN n’est créé', async () => {
    const racine = `${TERRAIN}-2`;
    await projetEnregistre(`${racine}/projet-x`);
    const jobId = await jobNeuf();

    const issue = await attachProductionToProject(ctx(jobId), [fichier(`${racine}/vrac/a.md`)]);

    expect(issue).toEqual({ kind: 'no_project' });
    expect(await projetDuJob(jobId)).toBeNull();

    // P5 n'enregistre RIEN hors du registre : aucune ligne pour `vrac`, et
    // surtout aucune ligne enregistrée. La question « où écrire ? » est P10.
    const lignes = await db
      .select({ id: codeProjects.id, registeredAt: codeProjects.registeredAt })
      .from(codeProjects)
      .where(
        and(
          eq(codeProjects.entityId, seed.entityId),
          eq(codeProjects.projectKey, projectKey(`${racine}/vrac`)),
        ),
      );
    expect(lignes).toEqual([]);
  });

  it('le PREMIER projet gagne : une écriture dans B laisse le job sur A', async () => {
    const racine = `${TERRAIN}-3`;
    const projetA = await projetEnregistre(`${racine}/a`);
    const projetB = await projetEnregistre(`${racine}/b`);
    const jobId = await jobNeuf();

    const premier = await attachProductionToProject(ctx(jobId), [fichier(`${racine}/a/x.ts`)]);
    expect(premier).toEqual({
      kind: 'attached',
      projectId: projetA,
      projectPath: `${racine}/a`,
    });

    const second = await attachProductionToProject(ctx(jobId), [fichier(`${racine}/b/y.ts`)]);
    expect(second).toEqual({
      kind: 'kept_existing',
      projectId: projetA,
      ignoredProjectId: projetB,
    });
    expect(await projetDuJob(jobId)).toBe(projetA);
  });

  it('deux tours dans le MÊME projet : already_attached, la ligne ne bouge pas', async () => {
    const racine = `${TERRAIN}-4`;
    const projetId = await projetEnregistre(`${racine}/app`);
    const jobId = await jobNeuf();

    await attachProductionToProject(ctx(jobId), [fichier(`${racine}/app/x.ts`)]);
    const second = await attachProductionToProject(ctx(jobId), [fichier(`${racine}/app/y.ts`)]);

    expect(second).toEqual({ kind: 'already_attached', projectId: projetId });
    expect(await projetDuJob(jobId)).toBe(projetId);
  });

  it('projets imbriqués : la cible va au plus NICHÉ', async () => {
    const racine = `${TERRAIN}-5`;
    await projetEnregistre(`${racine}/app`);
    const projetUi = await projetEnregistre(`${racine}/app/packages/ui`);
    const jobId = await jobNeuf();

    const issue = await attachProductionToProject(ctx(jobId), [
      fichier(`${racine}/app/packages/ui/src/Bouton.tsx`),
    ]);

    expect(issue).toEqual({
      kind: 'attached',
      projectId: projetUi,
      projectPath: `${racine}/app/packages/ui`,
    });
    expect(await projetDuJob(jobId)).toBe(projetUi);
  });

  it('un projet MASQUÉ reste le projet où le travail a eu lieu', async () => {
    // Masquer est un choix d'affichage, jamais une désinscription.
    const racine = `${TERRAIN}-6`;
    const projetId = await projetEnregistre(`${racine}/range`, { hidden: true });
    const jobId = await jobNeuf();

    await attachProductionToProject(ctx(jobId), [fichier(`${racine}/range/a.ts`)]);
    expect(await projetDuJob(jobId)).toBe(projetId);
  });

  it('Windows : la casse se replie, mais la FRONTIÈRE de segment tient', async () => {
    const projetId = await projetEnregistre('C:/Terrain/Projet-X');
    const voisinId = await projetEnregistre('C:/Terrain/Projet-X-bis');

    const jobCasse = await jobNeuf();
    const issue = await attachProductionToProject(ctx(jobCasse), [
      fichier('c:/terrain/projet-x/a.ts'),
    ]);
    expect(issue).toEqual({
      kind: 'attached',
      projectId: projetId,
      projectPath: 'C:/Terrain/Projet-X',
    });
    expect(await projetDuJob(jobCasse)).toBe(projetId);

    // `projet-x-bis` n'est PAS dans `projet-x` : sans la frontière `/`, il y
    // tomberait par simple préfixe de texte.
    const jobVoisin = await jobNeuf();
    await attachProductionToProject(ctx(jobVoisin), [fichier('C:/Terrain/Projet-X-bis/a.ts')]);
    expect(await projetDuJob(jobVoisin)).toBe(voisinId);
  });

  it('une ligne de COMPTABILITÉ n’est pas un projet : on ne s’y rattache pas', async () => {
    const racine = `${TERRAIN}-7`;
    await ligneDeComptabilite(`${racine}/touché`);
    const jobId = await jobNeuf();

    const issue = await attachProductionToProject(ctx(jobId), [fichier(`${racine}/touché/a.ts`)]);

    expect(issue).toEqual({ kind: 'no_project' });
    expect(await projetDuJob(jobId)).toBeNull();
  });

  it('sans jobId : no_job, et AUCUNE écriture', async () => {
    const racine = `${TERRAIN}-8`;
    await projetEnregistre(`${racine}/projet-y`);
    const temoin = await jobNeuf();

    const issue = await attachProductionToProject(ctx(null), [fichier(`${racine}/projet-y/a.ts`)]);

    expect(issue).toEqual({ kind: 'no_job' });
    // Le témoin prouve que rien n'a été posé « au hasard » sur un autre job.
    expect(await projetDuJob(temoin)).toBeNull();
  });

  it('une cible DOSSIER qui EST le projet s’y rattache', async () => {
    // Le runtime CLI ne cite pas de fichier : il cite le terrain lui-même.
    const racine = `${TERRAIN}-9`;
    const projetId = await projetEnregistre(racine);
    const jobId = await jobNeuf();

    const issue = await attachProductionToProject(ctx(jobId), [
      { kind: 'dir', path: racine, deliverableType: 'code_project' },
    ]);

    expect(issue).toEqual({ kind: 'attached', projectId: projetId, projectPath: racine });
    expect(await projetDuJob(jobId)).toBe(projetId);
  });
});
