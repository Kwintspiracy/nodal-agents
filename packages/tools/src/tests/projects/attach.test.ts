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

import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import {
  agentJobs,
  agents,
  codeProjects,
  conversations,
  entities,
  users,
  eq,
  and,
} from '@nodal-agents/db';
import { normalizePath, projectKey, type MutationTarget } from '@nodal-agents/shared';
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

/**
 * Sans dossier attaché (P5b) : rien ne peut être DÉCLARÉ, et les cas de ce
 * bloc prouvent le rattachement seul — `TERRAIN` n'existe pas sur le disque,
 * aucun manifeste ne s'y lit. La déclaration a son propre bloc plus bas.
 */
function ctx(jobId: string | null, conversationId: string | null = null) {
  return {
    db,
    entityId: seed.entityId,
    jobId,
    conversationId,
    agentId: seed.agentId,
    workspaces: [],
  };
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

/** Une conversation appartenant à une AUTRE entité — la cible de `not_found`. */
async function conversationDUneAutreEntite(chatId: string): Promise<string> {
  const [user] = await db
    .insert(users)
    .values({ email: `voisin-${Date.now()}-${chatId}@example.com` })
    .returning({ id: users.id });
  if (!user) throw new Error('insert user');
  const [autre] = await db
    .insert(entities)
    .values({ userId: user.id, name: 'Voisine', slug: `voisine-${Date.now()}-${chatId}` })
    .returning({ id: entities.id });
  if (!autre) throw new Error('insert entity');
  const [agent] = await db
    .insert(agents)
    .values({
      entityId: autre.id,
      name: 'Agent voisin',
      slug: `agent-voisin-${Date.now()}-${chatId}`,
      personality: 'p',
      role: 'agent',
    })
    .returning({ id: agents.id });
  if (!agent) throw new Error('insert agent');
  const [row] = await db
    .insert(conversations)
    .values({
      entityId: autre.id,
      agentId: agent.id,
      channel: 'telegram',
      chatId,
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
      jobProjectId: projetId,
      conversation: 'no_conversation',
      registered: [],
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
      jobProjectId: projetA,
      conversation: 'no_conversation',
      registered: [],
    });

    const second = await attachProductionToProject(ctx(jobId), [fichier(`${racine}/b/y.ts`)]);
    // `projectId` porte le projet TROUVÉ (B), `jobProjectId` celui que la ligne
    // GARDE (A) — le premier gagne, et les deux identités sont dites.
    expect(second).toEqual({
      kind: 'attached',
      projectId: projetB,
      projectPath: `${racine}/b`,
      job: 'kept_existing',
      jobProjectId: projetA,
      conversation: 'no_conversation',
      registered: [],
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
      jobProjectId: projetId,
      conversation: 'no_conversation',
      registered: [],
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
      jobProjectId: projetUi,
      conversation: 'no_conversation',
      registered: [],
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
      jobProjectId: projetId,
      conversation: 'no_conversation',
      registered: [],
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
      jobProjectId: projetId,
      conversation: 'no_conversation',
      registered: [],
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
      jobProjectId: projetId,
      conversation: 'set',
      registered: [],
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
      jobProjectId: projetB,
      conversation: 'set',
      registered: [],
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
      jobProjectId: projetA,
      conversation: 'set',
      registered: [],
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
      jobProjectId: null,
      conversation: 'set',
      registered: [],
    });
    expect(await projetDeLaConversation(conversationId)).toBe(projetId);
  });

  it("une conversation d'une AUTRE entité : not_found, et la ligne est INTACTE", async () => {
    // Le cas est réel : les uuid orphelins d'avant P6 que l'absence de clé
    // étrangère conserve délibérément. L'UPDATE ne touchait alors aucune ligne
    // et s'annonçait quand même `set` (revue Codex, passe 28).
    const racine = `${TERRAIN}-15`;
    const projetId = await projetEnregistre(`${racine}/app`);
    const voisine = await conversationDUneAutreEntite('chat-voisin');

    const issue = await attachProductionToProject(ctx(await jobNeuf(), voisine), [
      fichier(`${racine}/app/x.ts`),
    ]);

    expect(issue).toEqual({
      kind: 'attached',
      projectId: projetId,
      projectPath: `${racine}/app`,
      job: 'attached',
      jobProjectId: projetId,
      conversation: 'not_found',
      registered: [],
    });
    // La conversation de l'entité voisine n'a pas bougé.
    expect(await projetDeLaConversation(voisine)).toBeNull();
  });

  it('un id de conversation qui ne désigne AUCUNE ligne : not_found', async () => {
    const racine = `${TERRAIN}-16`;
    await projetEnregistre(`${racine}/app`);

    const issue = await attachProductionToProject(
      ctx(await jobNeuf(), '00000000-0000-0000-0000-000000000000'),
      [fichier(`${racine}/app/x.ts`)],
    );

    expect(issue).toMatchObject({ kind: 'attached', conversation: 'not_found' });
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

// ─── P5b : le registre se remplit tout seul ──────────────────────────────────
//
// La décision de Quentin (06/09) : un dossier où une production de code a
// atterri et qui porte un MANIFESTE est un projet, déclaré par la conversation
// qui y a produit. Ces cas lisent le disque (un terrain temporaire réel) parce
// que c'est le manifeste qui décide — et chacun relit la ligne `code_projects`.

describe('attachProductionToProject — la déclaration au registre (P5b)', () => {
  let terrain = '';

  beforeEach(async () => {
    // `realpath` : sur Windows, `tmpdir()` peut rendre la forme courte 8.3 ;
    // le terrain est pris sous sa forme réelle, comme un dossier attaché.
    terrain = normalizePath(
      realpathSync.native(await mkdtemp(join(tmpdir(), 'nodal-attach-p5b-'))),
    );
  });

  afterEach(async () => {
    try {
      await rm(terrain, { recursive: true, force: true });
    } catch {
      /* jetable */
    }
  });

  /** Le contexte d'un agent dont le terrain est `terrain`. */
  const ctxTerrain = (jobId: string | null, conversationId: string | null = null) => ({
    db,
    entityId: seed.entityId,
    jobId,
    conversationId,
    agentId: seed.agentId,
    workspaces: [{ path: terrain }],
  });

  const ligne = async (path: string) => {
    const [row] = await db
      .select({
        id: codeProjects.id,
        projectPath: codeProjects.projectPath,
        kind: codeProjects.kind,
        agentId: codeProjects.agentId,
        displayName: codeProjects.displayName,
        hidden: codeProjects.hidden,
        registeredAt: codeProjects.registeredAt,
        registeredFrom: codeProjects.registeredFrom,
        registeredJobId: codeProjects.registeredJobId,
        verifyCommands: codeProjects.verifyCommands,
        verificationEpoch: codeProjects.verificationEpoch,
      })
      .from(codeProjects)
      .where(
        and(
          eq(codeProjects.entityId, seed.entityId),
          eq(codeProjects.projectKey, projectKey(path)),
        ),
      );
    return row ?? null;
  };

  it('(a) un dossier à manifeste sans aucune ligne : DÉCLARÉ, le job rattaché, l’id dans `registered`', async () => {
    const app = `${terrain}/app`;
    await mkdir(`${app}/src`, { recursive: true });
    await writeFile(`${app}/package.json`, '{}');
    const jobId = await jobNeuf();
    const avant = new Date();

    const issue = await attachProductionToProject(ctxTerrain(jobId), [fichier(`${app}/src/a.ts`)]);

    const row = await ligne(app);
    expect(row, 'aucune ligne code_projects pour app').not.toBeNull();
    expect(issue).toEqual({
      kind: 'attached',
      projectId: row!.id,
      projectPath: app,
      job: 'attached',
      jobProjectId: row!.id,
      conversation: 'no_conversation',
      registered: [row!.id],
    });
    expect(row).toMatchObject({
      projectPath: app,
      kind: 'code',
      agentId: seed.agentId,
      displayName: null,
      hidden: false,
      registeredFrom: 'conversation',
      registeredJobId: jobId,
    });
    expect(row!.registeredAt!.getTime()).toBeGreaterThanOrEqual(avant.getTime() - 1000);
    expect(await projetDuJob(jobId)).toBe(row!.id);
  });

  it('(b) une ligne de COMPTABILITÉ (preuve configurée) devient déclarée, sa preuve intacte', async () => {
    const app = `${terrain}/app`;
    await mkdir(`${app}/src`, { recursive: true });
    await writeFile(`${app}/package.json`, '{}');
    const [compta] = await db
      .insert(codeProjects)
      .values({
        entityId: seed.entityId,
        projectPath: app,
        projectKey: projectKey(app),
        verifyCommands: [{ command: 'pnpm test' }] as never,
        verificationEpoch: 3,
      })
      .returning({ id: codeProjects.id });
    const jobId = await jobNeuf();

    const issue = await attachProductionToProject(ctxTerrain(jobId), [fichier(`${app}/src/a.ts`)]);

    expect(issue).toMatchObject({
      kind: 'attached',
      projectId: compta!.id,
      registered: [compta!.id],
    });
    const row = await ligne(app);
    expect(row).toMatchObject({
      id: compta!.id,
      registeredFrom: 'conversation',
      registeredJobId: jobId,
      agentId: seed.agentId,
      verificationEpoch: 3,
    });
    expect(row!.registeredAt).not.toBeNull();
    expect(row!.verifyCommands).toEqual([{ command: 'pnpm test' }]);
    // Une seule ligne pour ce dossier — pas une seconde créée à côté.
    const toutes = await db
      .select({ id: codeProjects.id })
      .from(codeProjects)
      .where(
        and(eq(codeProjects.entityId, seed.entityId), eq(codeProjects.projectKey, projectKey(app))),
      );
    expect(toutes).toHaveLength(1);
  });

  it('(c) un dossier SANS manifeste : rien n’est déclaré, `no_project`', async () => {
    const vrac = `${terrain}/vrac`;
    await mkdir(vrac, { recursive: true });
    const jobId = await jobNeuf();

    const issue = await attachProductionToProject(ctxTerrain(jobId), [fichier(`${vrac}/a.md`)]);

    expect(issue).toEqual({ kind: 'no_project' });
    expect(await ligne(vrac)).toBeNull();
    expect(await projetDuJob(jobId)).toBeNull();
  });

  it('(d) une ligne DÉJÀ déclarée n’est pas retouchée : `registered` vide, date d’origine gardée', async () => {
    const app = `${terrain}/app`;
    await mkdir(`${app}/src`, { recursive: true });
    await writeFile(`${app}/package.json`, '{}');
    const origine = new Date('2026-08-01T10:00:00.000Z');
    const [declaree] = await db
      .insert(codeProjects)
      .values({
        entityId: seed.entityId,
        projectPath: app,
        projectKey: projectKey(app),
        displayName: 'Mon app',
        agentId: seed.agentId,
        registeredAt: origine,
        registeredFrom: 'spaces',
      })
      .returning({ id: codeProjects.id });
    const jobId = await jobNeuf();

    const issue = await attachProductionToProject(ctxTerrain(jobId), [fichier(`${app}/src/a.ts`)]);

    expect(issue).toMatchObject({ kind: 'attached', projectId: declaree!.id, registered: [] });
    expect(await ligne(app)).toMatchObject({
      id: declaree!.id,
      displayName: 'Mon app',
      registeredAt: origine,
      registeredFrom: 'spaces',
      registeredJobId: null,
    });
  });

  it('(e) une ligne MASQUÉE se déclare en restant masquée', async () => {
    const app = `${terrain}/app`;
    await mkdir(`${app}/src`, { recursive: true });
    await writeFile(`${app}/package.json`, '{}');
    const [rangee] = await db
      .insert(codeProjects)
      .values({
        entityId: seed.entityId,
        projectPath: app,
        projectKey: projectKey(app),
        hidden: true,
      })
      .returning({ id: codeProjects.id });
    const jobId = await jobNeuf();

    const issue = await attachProductionToProject(ctxTerrain(jobId), [fichier(`${app}/src/a.ts`)]);

    expect(issue).toMatchObject({
      kind: 'attached',
      projectId: rangee!.id,
      registered: [rangee!.id],
    });
    expect(await ligne(app)).toMatchObject({ hidden: true, registeredFrom: 'conversation' });
  });

  it('(f) le terrain lui-même porte le manifeste : c’est LUI qui se déclare', async () => {
    await mkdir(`${terrain}/src`, { recursive: true });
    await writeFile(`${terrain}/package.json`, '{}');
    const jobId = await jobNeuf();

    const issue = await attachProductionToProject(ctxTerrain(jobId), [
      fichier(`${terrain}/src/x.ts`),
    ]);

    const row = await ligne(terrain);
    expect(row).not.toBeNull();
    expect(issue).toMatchObject({ kind: 'attached', projectId: row!.id, projectPath: terrain });
    expect(await ligne(`${terrain}/src`)).toBeNull();
  });

  it('(g) un DOCUMENT dans un dossier à manifeste ne déclare rien : seul le code se reconnaît seul', async () => {
    const app = `${terrain}/app`;
    await mkdir(app, { recursive: true });
    await writeFile(`${app}/package.json`, '{}');
    const jobId = await jobNeuf();

    const issue = await attachProductionToProject(ctxTerrain(jobId), [
      { kind: 'file', path: `${app}/rapport.xlsx`, deliverableType: 'office_file' },
    ]);

    expect(issue).toEqual({ kind: 'no_project' });
    expect(await ligne(app)).toBeNull();
  });

  it('sans dossier attaché, un manifeste ne suffit pas : rien n’est déclaré', async () => {
    const app = `${terrain}/app`;
    await mkdir(`${app}/src`, { recursive: true });
    await writeFile(`${app}/package.json`, '{}');
    const jobId = await jobNeuf();

    const issue = await attachProductionToProject({ ...ctxTerrain(jobId), workspaces: [] }, [
      fichier(`${app}/src/a.ts`),
    ]);

    expect(issue).toEqual({ kind: 'no_project' });
    expect(await ligne(app)).toBeNull();
  });
});

// ─── Passe Codex 32 ──────────────────────────────────────────────────────────

describe('attachProductionToProject — ce qui ne DÉCLARE pas (passe 32)', () => {
  let terrain = '';

  beforeEach(async () => {
    terrain = normalizePath(
      realpathSync.native(await mkdtemp(join(tmpdir(), 'nodal-attach-p32-'))),
    );
  });

  afterEach(async () => {
    try {
      await rm(terrain, { recursive: true, force: true });
    } catch {
      /* jetable */
    }
  });

  const ctxTerrain = (jobId: string | null, conversationId: string | null = null) => ({
    db,
    entityId: seed.entityId,
    jobId,
    conversationId,
    agentId: seed.agentId,
    workspaces: [{ path: terrain }],
  });

  const declaree = async (path: string) => {
    const [row] = await db
      .select({ id: codeProjects.id, registeredAt: codeProjects.registeredAt })
      .from(codeProjects)
      .where(
        and(
          eq(codeProjects.entityId, seed.entityId),
          eq(codeProjects.projectKey, projectKey(path)),
        ),
      );
    return row && row.registeredAt ? row : null;
  };

  it('(h) une cible DOSSIER ne déclare rien : un périmètre n’est pas une production', async () => {
    // Le terrain porte un manifeste ; un tour sans écriture connue passe le
    // terrain entier en cible `dir` (run-job.ts, run-chat.ts, une commande
    // shell). Déclarer là-dessus, c'est déclarer un dépôt parce qu'un agent a
    // répondu « je vais d'abord analyser » en mode écriture.
    await writeFile(`${terrain}/package.json`, '{}');
    const jobId = await jobNeuf();

    const issue = await attachProductionToProject(ctxTerrain(jobId), [
      { kind: 'dir', path: terrain, deliverableType: 'code_project' },
    ]);

    expect(issue).toEqual({ kind: 'no_project' });
    expect(await declaree(terrain)).toBeNull();
    expect(await projetDuJob(jobId)).toBeNull();
  });

  it('(h bis) la même cible dossier se RATTACHE à un projet déjà déclaré', async () => {
    await writeFile(`${terrain}/package.json`, '{}');
    const projetId = await projetEnregistre(terrain);
    const jobId = await jobNeuf();

    const issue = await attachProductionToProject(ctxTerrain(jobId), [
      { kind: 'dir', path: terrain, deliverableType: 'code_project' },
    ]);

    expect(issue).toMatchObject({ kind: 'attached', projectId: projetId, registered: [] });
    expect(await projetDuJob(jobId)).toBe(projetId);
  });

  it('(i) sans job, une conversation INEXISTANTE annule la déclaration : rien en base', async () => {
    const app = `${terrain}/app`;
    await mkdir(`${app}/src`, { recursive: true });
    await writeFile(`${app}/package.json`, '{}');

    const issue = await attachProductionToProject(
      ctxTerrain(null, '00000000-0000-0000-0000-000000000000'),
      [fichier(`${app}/src/a.ts`)],
    );

    expect(issue).toEqual({ kind: 'failed', code: 'attach_registered_without_anchor' });
    // La transaction a tout repris : ni déclaration, ni ligne de comptabilité.
    expect(await declaree(app)).toBeNull();
  });

  it('(i bis) avec un job, la même conversation inexistante n’empêche rien : le job est l’ancre', async () => {
    const app = `${terrain}/app`;
    await mkdir(`${app}/src`, { recursive: true });
    await writeFile(`${app}/package.json`, '{}');
    const jobId = await jobNeuf();

    const issue = await attachProductionToProject(
      ctxTerrain(jobId, '00000000-0000-0000-0000-000000000000'),
      [fichier(`${app}/src/a.ts`)],
    );

    expect(issue).toMatchObject({ kind: 'attached', job: 'attached', conversation: 'not_found' });
    const row = await declaree(app);
    expect(row).not.toBeNull();
    expect(await projetDuJob(jobId)).toBe(row!.id);
  });

  it('(j) un job INEXISTANT annule la déclaration', async () => {
    const app = `${terrain}/app`;
    await mkdir(`${app}/src`, { recursive: true });
    await writeFile(`${app}/package.json`, '{}');

    const issue = await attachProductionToProject(
      ctxTerrain('00000000-0000-0000-0000-000000000000'),
      [fichier(`${app}/src/a.ts`)],
    );

    // La clé étrangère `registered_job_id → agent_jobs` refuse l'INSERT avant
    // même que `markJob` ne cherche le job : le code est celui de la panne
    // d'écriture. Ce qui compte : c'est une panne DITE, et rien n'est resté.
    expect(issue.kind).toBe('failed');
    expect(await declaree(app)).toBeNull();
  });
});
