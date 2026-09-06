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
//   - sans job ni conversation, rien n'est écrit ;
//   - P6 : la CONVERSATION retient le projet, et la DERNIÈRE production décide
//     (l'inverse de la règle du job), y compris sans job du tout.
//
// Aucune assertion sur une issue seule : chaque cas relit `agent_jobs` ou
// `conversations` en base.

import { describe, it, expect, beforeAll } from 'vitest';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import { agentJobs, codeProjects, conversations, eq, and } from '@nodal-agents/db';
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

function ctx(jobId: string | null, conversationId: string | null = null) {
  return { db, entityId: seed.entityId, jobId, conversationId };
}

/** Une conversation de canal — celle qui portera le projet courant (P6). */
async function conversationNeuve(chatId: string): Promise<string> {
  const [row] = await db
    .insert(conversations)
    .values({
      entityId: seed.entityId,
      agentId: seed.agentId,
      channel: 'telegram',
      chatId,
      title: '',
      origin: 'user',
    })
    .returning({ id: conversations.id });
  if (!row) throw new Error('insert conversation');
  return row.id;
}

async function projetDeLaConversation(conversationId: string): Promise<string | null> {
  const [row] = await db
    .select({ currentProjectId: conversations.currentProjectId })
    .from(conversations)
    .where(eq(conversations.id, conversationId));
  if (!row) throw new Error('conversation introuvable');
  return row.currentProjectId;
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
      job: 'attached',
      conversation: 'no_conversation',
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
      job: 'attached',
      conversation: 'no_conversation',
    });

    const second = await attachProductionToProject(ctx(jobId), [fichier(`${racine}/b/y.ts`)]);
    // Le kind porte le projet TROUVÉ (B) ; `job: 'kept_existing'` dit que la
    // ligne, elle, garde A — le premier gagne.
    expect(second).toEqual({
      kind: 'attached',
      projectId: projetB,
      projectPath: `${racine}/b`,
      job: 'kept_existing',
      conversation: 'no_conversation',
    });
    expect(await projetDuJob(jobId)).toBe(projetA);
  });

  it('deux tours dans le MÊME projet : already_attached, la ligne ne bouge pas', async () => {
    const racine = `${TERRAIN}-4`;
    const projetId = await projetEnregistre(`${racine}/app`);
    const jobId = await jobNeuf();

    await attachProductionToProject(ctx(jobId), [fichier(`${racine}/app/x.ts`)]);
    const second = await attachProductionToProject(ctx(jobId), [fichier(`${racine}/app/y.ts`)]);

    expect(second).toEqual({
      kind: 'attached',
      projectId: projetId,
      projectPath: `${racine}/app`,
      job: 'already_attached',
      conversation: 'no_conversation',
    });
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
      job: 'attached',
      conversation: 'no_conversation',
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
      job: 'attached',
      conversation: 'no_conversation',
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

  it('sans jobId NI conversation : aucune ligne à marquer, et AUCUNE écriture', async () => {
    const racine = `${TERRAIN}-8`;
    await projetEnregistre(`${racine}/projet-y`);
    const temoin = await jobNeuf();

    const issue = await attachProductionToProject(ctx(null), [fichier(`${racine}/projet-y/a.ts`)]);

    expect(issue).toEqual({ kind: 'no_project' });
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

    expect(issue).toEqual({
      kind: 'attached',
      projectId: projetId,
      projectPath: racine,
      job: 'attached',
      conversation: 'no_conversation',
    });
    expect(await projetDuJob(jobId)).toBe(projetId);
  });
});

describe('attachProductionToProject — le projet COURANT de la conversation (P6)', () => {
  it('pose current_project_id sur la conversation, relu en base', async () => {
    const racine = `${TERRAIN}-10`;
    const projetId = await projetEnregistre(`${racine}/app`);
    const jobId = await jobNeuf();
    const conversationId = await conversationNeuve('chat-p6-1');

    const issue = await attachProductionToProject(ctx(jobId, conversationId), [
      fichier(`${racine}/app/src/a.ts`),
    ]);

    expect(issue).toEqual({
      kind: 'attached',
      projectId: projetId,
      projectPath: `${racine}/app`,
      job: 'attached',
      conversation: 'set',
    });
    expect(await projetDeLaConversation(conversationId)).toBe(projetId);
  });

  it('la DERNIÈRE production décide : un autre projet ÉCRASE le courant', async () => {
    // C'est l'inverse de la règle du job (« le premier gagne »), et c'est voulu :
    // un job est un travail, une conversation dure et suit où l'on travaille.
    const racine = `${TERRAIN}-11`;
    const projetA = await projetEnregistre(`${racine}/a`);
    const projetB = await projetEnregistre(`${racine}/b`);
    const conversationId = await conversationNeuve('chat-p6-2');

    await attachProductionToProject(ctx(await jobNeuf(), conversationId), [
      fichier(`${racine}/a/x.ts`),
    ]);
    expect(await projetDeLaConversation(conversationId)).toBe(projetA);

    const second = await attachProductionToProject(ctx(await jobNeuf(), conversationId), [
      fichier(`${racine}/b/y.ts`),
    ]);
    expect(second).toEqual({
      kind: 'attached',
      projectId: projetB,
      projectPath: `${racine}/b`,
      job: 'attached',
      conversation: 'set',
    });
    expect(await projetDeLaConversation(conversationId)).toBe(projetB);
  });

  it('écrase même quand le JOB, lui, garde son premier projet', async () => {
    const racine = `${TERRAIN}-12`;
    const projetA = await projetEnregistre(`${racine}/a`);
    const projetB = await projetEnregistre(`${racine}/b`);
    const jobId = await jobNeuf();
    const conversationId = await conversationNeuve('chat-p6-3');

    await attachProductionToProject(ctx(jobId, conversationId), [fichier(`${racine}/a/x.ts`)]);
    const second = await attachProductionToProject(ctx(jobId, conversationId), [
      fichier(`${racine}/b/y.ts`),
    ]);

    expect(second).toEqual({
      kind: 'attached',
      projectId: projetB,
      projectPath: `${racine}/b`,
      job: 'kept_existing',
      conversation: 'set',
    });
    // Deux règles, deux lignes : le job reste sur A, la conversation passe à B.
    expect(await projetDuJob(jobId)).toBe(projetA);
    expect(await projetDeLaConversation(conversationId)).toBe(projetB);
  });

  it('sans jobId mais AVEC conversation (tour de chat CLI) : posé quand même', async () => {
    const racine = `${TERRAIN}-13`;
    const projetId = await projetEnregistre(`${racine}/docs`);
    const conversationId = await conversationNeuve('chat-p6-4');

    const issue = await attachProductionToProject(ctx(null, conversationId), [
      { kind: 'dir', path: `${racine}/docs`, deliverableType: 'code_project' },
    ]);

    expect(issue).toEqual({
      kind: 'attached',
      projectId: projetId,
      projectPath: `${racine}/docs`,
      job: 'no_job',
      conversation: 'set',
    });
    expect(await projetDeLaConversation(conversationId)).toBe(projetId);
  });

  it('hors de tout projet : la conversation garde son projet courant', async () => {
    const racine = `${TERRAIN}-14`;
    const projetId = await projetEnregistre(`${racine}/app`);
    const conversationId = await conversationNeuve('chat-p6-5');

    await attachProductionToProject(ctx(await jobNeuf(), conversationId), [
      fichier(`${racine}/app/x.ts`),
    ]);
    const issue = await attachProductionToProject(ctx(await jobNeuf(), conversationId), [
      fichier(`${racine}/vrac/note.md`),
    ]);

    // « Rien trouvé » n'est pas « oublie où tu travaillais ».
    expect(issue).toEqual({ kind: 'no_project' });
    expect(await projetDeLaConversation(conversationId)).toBe(projetId);
  });
});
