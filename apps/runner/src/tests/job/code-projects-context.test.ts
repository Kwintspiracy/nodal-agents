// code-projects-context.test.ts — la liste des projets injectée dans le bloc
// Runtime de chaque agent.
//
// L'incident fondateur (3 sessions de suite, 25/08) : « modifie l'app
// calorie-counter » arrive au root, qui ne sait ni où elle vit ni à qui la
// confier — il cherche à l'aveugle, échoue, et une fois annonce même un
// travail jamais fait. Ce que ce test doit prouver n'est donc pas « la
// fonction rend une liste » mais : le bon DOSSIER de projet (pas le
// workspace-conteneur), les bons DÉTENTEURS (les agents dont le workspace le
// contient), et rien d'inventé — sur un VRAI arbre disque.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import {
  eq,
  agents,
  agentWorkspaces,
  agentJobs,
  codeProjects,
  entities,
  toolCalls,
} from '@nodal-agents/db';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RunnerDeps } from '../../deps.ts';
import {
  listCodeProjectsForContext,
  projectKey as projectKeyOf,
  _resetProjectsCacheForTests,
} from '../../job/code-projects.ts';

let db: TestDb;
let seed: Awaited<ReturnType<typeof seedMinimal>>;
let racine = '';
const norm = (p: string) => p.replace(/\\/g, '/');

let devAgentId = '';
let leadAgentId = '';

beforeAll(async () => {
  const result = await spinUpTestDb();
  db = result.db;
  seed = await seedMinimal(db);

  // Arbre réel : un workspace CONTENEUR avec deux apps.
  racine = norm(await mkdtemp(join(tmpdir(), 'nodal-ctx-test-')));
  await mkdir(join(racine, 'dev', 'calorie-counter', 'app'), { recursive: true });
  await writeFile(join(racine, 'dev', 'calorie-counter', 'index.html'), '<!doctype html>');
  await writeFile(join(racine, 'dev', 'calorie-counter', 'app', 'app.js'), '// app');
  await mkdir(join(racine, 'dev', 'water-intake'), { recursive: true });
  await writeFile(join(racine, 'dev', 'water-intake', 'main.js'), '// water');
  const ws = `${racine}/dev`;

  const [dev] = await db
    .insert(agents)
    .values({
      entityId: seed.entityId,
      name: 'Dev C',
      slug: `dev-c-${Date.now()}`,
      personality: 'x',
    })
    .returning();
  devAgentId = dev!.id;
  const [lead] = await db
    .insert(agents)
    .values({
      entityId: seed.entityId,
      name: 'Lead-Dev',
      slug: `lead-${Date.now()}`,
      personality: 'x',
    })
    .returning();
  leadAgentId = lead!.id;

  // Le dossier partagé, attaché aux deux agents. Depuis le 26/08 rien d'autre
  // n'est demandé : ni extension, ni skill, ni case à cocher. Ce qui est écrit
  // dans un dossier attaché devient un projet, et le propriétaire range ce
  // qu'il ne veut pas voir.
  for (const agentId of [devAgentId, leadAgentId]) {
    await db.insert(agentWorkspaces).values({
      entityId: seed.entityId,
      agentId,
      label: 'Dev',
      path: ws,
    });
  }

  const [job] = await db
    .insert(agentJobs)
    .values({
      entityId: seed.entityId,
      agentId: devAgentId,
      status: 'completed',
      channel: 'api',
      task: 'build the apps',
    })
    .returning();

  await db.insert(toolCalls).values([
    {
      entityId: seed.entityId,
      jobId: job!.id,
      toolName: 'cli:Edit',
      toolInput: { file_path: `${racine}/dev/calorie-counter/app/app.js` },
      toolOutput: 'ok',
    },
    {
      entityId: seed.entityId,
      jobId: job!.id,
      toolName: 'file_write',
      toolInput: { path: `${racine}/dev/water-intake/main.js` },
      toolOutput: '{"ok":true}',
    },
    // Une écriture REFUSÉE ne crée pas de projet.
    {
      entityId: seed.entityId,
      jobId: job!.id,
      toolName: 'cli:Write',
      toolInput: { file_path: `${racine}/dev/ghost-app/index.js` },
      toolOutput: '<tool_use_error>No such tool available: Write.</tool_use_error>',
    },
  ]);
});

// Le cache de 60 s par entité rendait muettes toutes les assertions qui
// suivaient la première : chaque test relisait la liste mémoïsée au lieu de la
// recalculer. Découvert en vérifiant par mutation un test de filtrage qui
// passait encore, filtre débranché.
beforeEach(() => {
  _resetProjectsCacheForTests();
});

afterAll(async () => {
  if (racine) await rm(racine, { recursive: true, force: true });
});

describe('listCodeProjectsForContext', () => {
  it('rend un projet par APP (jamais le workspace-conteneur) avec ses détenteurs', async () => {
    const projects = await listCodeProjectsForContext(db as RunnerDeps['db'], seed.entityId);
    const names = projects.map((p) => p.name).sort();
    expect(names).toEqual(['calorie-counter', 'water-intake']);

    const calorie = projects.find((p) => p.name === 'calorie-counter')!;
    expect(calorie.path).toBe(`${racine}/dev/calorie-counter`);
    // Les deux agents partagent le workspace → tous deux détenteurs.
    expect(calorie.owners).toEqual(['Dev C', 'Lead-Dev']);
    expect(calorie.lastActivityAt).toBeTruthy();

    // Le conteneur lui-même n'est JAMAIS un projet.
    expect(projects.some((p) => p.path === `${racine}/dev`)).toBe(false);
  });

  it('une écriture refusée ne crée aucun projet', async () => {
    const projects = await listCodeProjectsForContext(db as RunnerDeps['db'], seed.entityId);
    expect(
      projects.some((p) => p.name === 'ghost-app'),
      'un projet est né d’une écriture refusée',
    ).toBe(false);
  });

  it('un DOSSIER masqué retire tous ses projets du contexte, et son label reste lu', async () => {
    // Le pendant runner de la case posée sur le dossier (0087). L'onglet et le
    // prompt doivent dire la même chose : masquer un coffre de notes le sort
    // des deux, sinon les agents s'entendraient annoncer des projets que le
    // propriétaire ne voit plus.
    //
    // Le second volet est le piège : le LABEL du dossier masqué doit rester lu.
    // Sans lui, `coffre/note.md` ne serait plus reconnu comme une écriture dans
    // le coffre et se recollerait au dossier suivant — le coffre réapparaîtrait
    // sous un projet qui n'a rien demandé.
    const coffre = norm(await mkdtemp(join(tmpdir(), 'nodal-masq-')));
    for (const sujet of ['Physique', 'Warhammer']) {
      await mkdir(join(coffre, sujet), { recursive: true });
      await writeFile(join(coffre, sujet, 'note.md'), '# note');
    }

    const [scribe] = await db
      .insert(agents)
      .values({
        entityId: seed.entityId,
        name: 'Scribe masque',
        slug: `scribe-masq-${Date.now()}`,
        personality: 'x',
      })
      .returning();
    // DEUX dossiers : c'est ce qui force la forme `label/fichier` et donc met
    // la résolution par label en jeu.
    const [wsCoffre] = await db
      .insert(agentWorkspaces)
      .values([
        { entityId: seed.entityId, agentId: scribe!.id, label: 'coffre', path: coffre },
        { entityId: seed.entityId, agentId: scribe!.id, label: 'Dev', path: `${racine}/dev` },
      ])
      .returning();
    const [jobScribe] = await db
      .insert(agentJobs)
      .values({
        entityId: seed.entityId,
        agentId: scribe!.id,
        status: 'completed',
        channel: 'api',
        task: 'notes',
      })
      .returning();
    await db.insert(toolCalls).values([
      {
        entityId: seed.entityId,
        jobId: jobScribe!.id,
        toolName: 'file_write',
        toolInput: { path: 'coffre/Physique/note.md' },
        toolOutput: '{"ok":true}',
      },
      {
        entityId: seed.entityId,
        jobId: jobScribe!.id,
        toolName: 'file_write',
        toolInput: { path: 'coffre/Warhammer/note.md' },
        toolOutput: '{"ok":true}',
      },
    ]);
    _resetProjectsCacheForTests();

    try {
      const avant = await listCodeProjectsForContext(db as RunnerDeps['db'], seed.entityId);
      expect(
        avant.filter((p) => p.path.startsWith(coffre)).length,
        'les sujets du coffre devraient être des projets tant qu’il n’est pas masqué',
      ).toBe(2);

      await db
        .update(agentWorkspaces)
        .set({ hiddenFromCode: true })
        .where(eq(agentWorkspaces.id, wsCoffre!.id));
      _resetProjectsCacheForTests();

      const apres = await listCodeProjectsForContext(db as RunnerDeps['db'], seed.entityId);
      expect(
        apres.filter((p) => p.path.startsWith(coffre)),
        'un dossier masqué est encore annoncé aux agents',
      ).toHaveLength(0);
      // Et surtout : ses écritures n'ont PAS été recollées ailleurs.
      expect(
        apres.some((p) => p.path === `${racine}/dev/Physique` || p.path === `${racine}/dev/coffre`),
        'l’écriture du coffre masqué a été recollée au dossier suivant',
      ).toBe(false);
    } finally {
      await db.delete(toolCalls).where(eq(toolCalls.jobId, jobScribe!.id));
      await db.delete(agentWorkspaces).where(eq(agentWorkspaces.agentId, scribe!.id));
      await rm(coffre, { recursive: true, force: true });
      _resetProjectsCacheForTests();
    }
  });

  it('masquer un dossier prend effet IMMÉDIATEMENT, et un dossier NICHÉ ne ressort pas par le parent', async () => {
    // Deux constats de la revue Codex (26/08), sur le même montage :
    //
    //  * le scan est mis en cache 60 s. Y cuire la visibilité ferait qu'un
    //    dossier masqué resterait annoncé aux agents pendant une minute — et un
    //    dossier réaffiché, absent d'autant. Ce test ne vide PAS le cache après
    //    la bascule, c'est tout son objet.
    //  * `/data` suivi, `/data/coffre` masqué : écarter la seule racine masquée
    //    laissait le parent visible ramasser ses écritures, et le coffre
    //    ressortait comme projet. Le masquage contourné par le haut.
    const parent = norm(await mkdtemp(join(tmpdir(), 'nodal-niche-')));
    await mkdir(join(parent, 'coffre', 'Physique'), { recursive: true });
    await writeFile(join(parent, 'coffre', 'Physique', 'note.md'), '# note');
    await mkdir(join(parent, 'app'), { recursive: true });
    await writeFile(join(parent, 'app', 'x.ts'), 'export {}');

    const [ag] = await db
      .insert(agents)
      .values({
        entityId: seed.entityId,
        name: 'Agent niche',
        slug: `niche-${Date.now()}`,
        personality: 'x',
      })
      .returning();
    const [wsParent, wsCoffre] = await db
      .insert(agentWorkspaces)
      .values([
        { entityId: seed.entityId, agentId: ag!.id, label: 'data', path: parent },
        { entityId: seed.entityId, agentId: ag!.id, label: 'coffre', path: `${parent}/coffre` },
      ])
      .returning();
    const [jobNiche] = await db
      .insert(agentJobs)
      .values({
        entityId: seed.entityId,
        agentId: ag!.id,
        status: 'completed',
        channel: 'api',
        task: 'mix',
      })
      .returning();
    await db.insert(toolCalls).values([
      {
        entityId: seed.entityId,
        jobId: jobNiche!.id,
        toolName: 'file_write',
        toolInput: { path: `${parent}/coffre/Physique/note.md` },
        toolOutput: '{"ok":true}',
      },
      {
        entityId: seed.entityId,
        jobId: jobNiche!.id,
        toolName: 'file_write',
        toolInput: { path: `${parent}/app/x.ts` },
        toolOutput: '{"ok":true}',
      },
    ]);
    _resetProjectsCacheForTests();

    try {
      // Un premier appel remplit le cache, coffre encore visible.
      const avant = await listCodeProjectsForContext(db as RunnerDeps['db'], seed.entityId);
      expect(avant.some((p) => p.path === `${parent}/coffre/Physique`)).toBe(true);

      await db
        .update(agentWorkspaces)
        .set({ hiddenFromCode: true })
        .where(eq(agentWorkspaces.id, wsCoffre!.id));
      // PAS de purge du cache : c'est la moitié du test.

      const apres = await listCodeProjectsForContext(db as RunnerDeps['db'], seed.entityId);
      expect(
        apres.some((p) => p.path.startsWith(`${parent}/coffre`)),
        'le coffre reste annoncé aux agents tant que le cache n’a pas expiré',
      ).toBe(false);
      expect(
        apres.some((p) => p.path === `${parent}/coffre`),
        'le coffre masqué est ressorti par son dossier parent',
      ).toBe(false);
      // Le parent, lui, continue de produire ses propres projets.
      expect(apres.some((p) => p.path === `${parent}/app`)).toBe(true);
    } finally {
      await db.delete(toolCalls).where(eq(toolCalls.jobId, jobNiche!.id));
      await db.delete(agentWorkspaces).where(eq(agentWorkspaces.id, wsParent!.id));
      await db.delete(agentWorkspaces).where(eq(agentWorkspaces.id, wsCoffre!.id));
      await rm(parent, { recursive: true, force: true });
      _resetProjectsCacheForTests();
    }
  });

  it('MASQUER un projet le retire du contexte des agents — la demande exacte de Quentin', async () => {
    // « on fait en sorte que ça retire le dossier du contexte et de la mémoire
    // des agents » (26/08).
    //
    // Jusque-là, l'archivage n'était lu QUE par l'interface : un projet rangé
    // disparaissait de l'onglet Code et continuait d'être annoncé, détenteurs
    // compris, dans le prompt système de tous les agents. Ranger quelque chose
    // et continuer à en parler à tout le monde n'avait pas de sens.
    const projet = `${racine}/dev/water-intake`;

    const avant = await listCodeProjectsForContext(db as RunnerDeps['db'], seed.entityId);
    expect(avant.map((p) => p.name).sort()).toEqual(['calorie-counter', 'water-intake']);

    await db
      .insert(codeProjects)
      .values({ entityId: seed.entityId, projectPath: projet, hidden: true });
    _resetProjectsCacheForTests();

    try {
      const apres = await listCodeProjectsForContext(db as RunnerDeps['db'], seed.entityId);
      expect(
        apres.some((p) => p.path === projet),
        'un projet masqué est encore annoncé aux agents',
      ).toBe(false);
      // Les autres projets ne bougent pas : masquer vise UN projet, pas le lot.
      expect(apres.map((p) => p.name)).toEqual(['calorie-counter']);
    } finally {
      await db.delete(codeProjects).where(eq(codeProjects.projectPath, projet));
      _resetProjectsCacheForTests();
    }
  });

  it('une écriture RELATIVE par label entre dans le contexte, chez SON auteur', async () => {
    // Constat P1 de la revue Codex (26/08). Dès qu'un agent a plus d'un
    // dossier, les outils Nodal enregistrent `label/fichier` — et le scan ne
    // lisait pas les labels : il essayait `<racine>/coffre/note.md` sous chaque
    // racine, un chemin qui n'existe nulle part. Ces écritures n'entraient donc
    // JAMAIS dans le contexte injecté, alors que l'onglet Code les résolvait.
    // Deux vues, deux vérités.
    //
    // Le label n'étant unique que par AGENT, la résolution se fait chez
    // l'auteur de l'appel, pas dans un sac commun.
    const coffre = norm(await mkdtemp(join(tmpdir(), 'nodal-label-')));
    await mkdir(join(coffre, 'carnet'), { recursive: true });
    await writeFile(join(coffre, 'carnet', 'note.md'), '# note');

    const [polyvalent] = await db
      .insert(agents)
      .values({
        entityId: seed.entityId,
        name: 'Agent polyvalent',
        slug: `polyvalent-${Date.now()}`,
        personality: 'x',
      })
      .returning();
    // DEUX dossiers : c'est ce qui force la forme `label/fichier`.
    await db.insert(agentWorkspaces).values([
      { entityId: seed.entityId, agentId: polyvalent!.id, label: 'Dev', path: `${racine}/dev` },
      { entityId: seed.entityId, agentId: polyvalent!.id, label: 'coffre', path: coffre },
    ]);
    const [jobPoly] = await db
      .insert(agentJobs)
      .values({
        entityId: seed.entityId,
        agentId: polyvalent!.id,
        status: 'completed',
        channel: 'api',
        task: 'note',
      })
      .returning();
    await db.insert(toolCalls).values({
      entityId: seed.entityId,
      jobId: jobPoly!.id,
      toolName: 'file_write',
      toolInput: { path: 'coffre/carnet/note.md' },
      toolOutput: '{"ok":true}',
    });
    _resetProjectsCacheForTests();

    try {
      const projects = await listCodeProjectsForContext(db as RunnerDeps['db'], seed.entityId);
      const carnet = projects.find((p) => p.path === `${coffre}/carnet`);
      expect(
        carnet,
        'une écriture relative par label n’est jamais entrée dans le contexte',
      ).toBeTruthy();
      expect(carnet!.owners).toEqual(['Agent polyvalent']);
    } finally {
      await db.delete(toolCalls).where(eq(toolCalls.jobId, jobPoly!.id));
      await db.delete(agentWorkspaces).where(eq(agentWorkspaces.agentId, polyvalent!.id));
      await rm(coffre, { recursive: true, force: true });
      _resetProjectsCacheForTests();
    }
  });

  it('un FICHIER supprimé ne fait pas disparaître son projet ; un PROJET supprimé, si', async () => {
    // Constat Codex (26/08) : le scan exigeait que le fichier édité existe
    // encore. Un renommage, un refactor, un `.tmp` nettoyé, et le projet
    // sortait du contexte alors qu'il est bien vivant — pendant que l'onglet
    // Code continuait de l'afficher, puisque LUI vérifie le dossier de projet.
    const vivant = join(racine, 'dev', 'vivant');
    await mkdir(vivant, { recursive: true });
    await writeFile(join(vivant, 'garde.ts'), 'export {}');

    const [job2] = await db
      .insert(agentJobs)
      .values({
        entityId: seed.entityId,
        agentId: devAgentId,
        status: 'completed',
        channel: 'api',
        task: 'refactor',
      })
      .returning();
    // Un fichier qui n'existe PLUS : supprimé après avoir été édité.
    await db.insert(toolCalls).values({
      entityId: seed.entityId,
      jobId: job2!.id,
      toolName: 'file_write',
      toolInput: { path: `${racine}/dev/vivant/ancien-nom.ts` },
      toolOutput: '{"ok":true}',
    });
    _resetProjectsCacheForTests();

    try {
      const projects = await listCodeProjectsForContext(db as RunnerDeps['db'], seed.entityId);
      expect(
        projects.some((p) => p.path === `${racine}/dev/vivant`),
        'un fichier supprimé a emporté son projet avec lui',
      ).toBe(true);

      // Le dossier de projet, lui, fait foi : supprimé, le projet s'en va.
      await rm(vivant, { recursive: true, force: true });
      _resetProjectsCacheForTests();
      const apres = await listCodeProjectsForContext(db as RunnerDeps['db'], seed.entityId);
      expect(
        apres.some((p) => p.path === `${racine}/dev/vivant`),
        'un projet supprimé du disque est encore annoncé aux agents',
      ).toBe(false);
    } finally {
      await db.delete(toolCalls).where(eq(toolCalls.jobId, job2!.id));
      await rm(vivant, { recursive: true, force: true });
      _resetProjectsCacheForTests();
    }
  });

  it('un chemin relatif SANS label ne va pas piocher dans le dossier d’un autre agent', async () => {
    // Constat Codex (26/08). Quand aucun label ne correspond, l'existence sur
    // disque tranche — mais parmi les dossiers de l'AUTEUR, pas de tout
    // l'espace. Chercher partout attribuait l'écriture au projet d'un agent
    // qui n'y est pour rien dès qu'un chemin homonyme existait ailleurs.
    //
    // Ici : `commun/app.js` existe chez DEUX agents. Celui qui écrit est le
    // second ; c'est SON dossier qui doit gagner.
    //
    // Le dossier du VOISIN porte volontairement un nom plus LONG : les racines
    // sont triées de la plus longue à la plus courte, donc il est examiné en
    // premier. Sans ce détail le test serait décoratif — constaté en le
    // vérifiant par mutation, où il passait encore avec la recherche élargie.
    const chezLAutre = norm(await mkdtemp(join(tmpdir(), 'nodal-homo-voisin-au-nom-tres-long-')));
    const chezLAuteur = norm(await mkdtemp(join(tmpdir(), 'nodal-homo-b-')));
    for (const base of [chezLAutre, chezLAuteur]) {
      await mkdir(join(base, 'commun'), { recursive: true });
      await writeFile(join(base, 'commun', 'app.js'), '// app');
    }

    const [autre] = await db
      .insert(agents)
      .values({
        entityId: seed.entityId,
        name: 'Agent voisin',
        slug: `voisin-homo-${Date.now()}`,
        personality: 'x',
      })
      .returning();
    const [auteur] = await db
      .insert(agents)
      .values({
        entityId: seed.entityId,
        name: 'Agent auteur',
        slug: `auteur-homo-${Date.now()}`,
        personality: 'x',
      })
      .returning();
    await db.insert(agentWorkspaces).values([
      { entityId: seed.entityId, agentId: autre!.id, label: 'A', path: chezLAutre },
      // DEUX dossiers pour l'auteur : sans ça la règle « dossier unique »
      // trancherait avant d'arriver au cas testé.
      { entityId: seed.entityId, agentId: auteur!.id, label: 'B', path: chezLAuteur },
      { entityId: seed.entityId, agentId: auteur!.id, label: 'C', path: `${racine}/dev` },
    ]);
    const [jobAuteur] = await db
      .insert(agentJobs)
      .values({
        entityId: seed.entityId,
        agentId: auteur!.id,
        status: 'completed',
        channel: 'api',
        task: 'app',
      })
      .returning();
    await db.insert(toolCalls).values({
      entityId: seed.entityId,
      jobId: jobAuteur!.id,
      toolName: 'file_write',
      toolInput: { path: 'commun/app.js' },
      toolOutput: '{"ok":true}',
    });
    _resetProjectsCacheForTests();

    try {
      const projects = await listCodeProjectsForContext(db as RunnerDeps['db'], seed.entityId);
      expect(
        projects.some((p) => p.path === `${chezLAutre}/commun`),
        'l’écriture a été attribuée au dossier d’un agent qui n’y est pour rien',
      ).toBe(false);
      expect(
        projects.some((p) => p.path === `${chezLAuteur}/commun`),
        'l’écriture n’a pas été rattachée au dossier de son auteur',
      ).toBe(true);
    } finally {
      await db.delete(toolCalls).where(eq(toolCalls.jobId, jobAuteur!.id));
      await db.delete(agentWorkspaces).where(eq(agentWorkspaces.agentId, autre!.id));
      await db.delete(agentWorkspaces).where(eq(agentWorkspaces.agentId, auteur!.id));
      await rm(chezLAutre, { recursive: true, force: true });
      await rm(chezLAuteur, { recursive: true, force: true });
      _resetProjectsCacheForTests();
    }
  });

  it('masquer prend effet IMMÉDIATEMENT, sans attendre l’expiration du cache', async () => {
    // Constat Codex (26/08) : le cache de 60 s portait AUSSI les préférences.
    // Masquer un projet le laissait donc annoncé aux agents pendant une minute,
    // pendant que l'interface confirmait « vos agents ne le voient plus ». Un
    // message vrai à l'écran et faux dans les faits est pire que pas de message.
    //
    // Ce test ne vide PAS le cache après l'écriture — c'est tout son objet.
    const projet = `${racine}/dev/water-intake`;

    // Un premier appel remplit le cache.
    const avant = await listCodeProjectsForContext(db as RunnerDeps['db'], seed.entityId);
    expect(avant.some((p) => p.path === projet)).toBe(true);

    await db
      .insert(codeProjects)
      .values({ entityId: seed.entityId, projectPath: projet, hidden: true });

    try {
      const apres = await listCodeProjectsForContext(db as RunnerDeps['db'], seed.entityId);
      expect(
        apres.some((p) => p.path === projet),
        'le projet reste annoncé aux agents tant que le cache n’a pas expiré',
      ).toBe(false);
    } finally {
      await db.delete(codeProjects).where(eq(codeProjects.projectPath, projet));
      _resetProjectsCacheForTests();
    }
  });

  it('la casse d’un chemin POSIX est PRÉSERVÉE : deux dossiers, deux projets', async () => {
    // Constat Codex (26/08) : replier la casse sans condition confond
    // `/srv/App` et `/srv/app`, qui sont deux dossiers distincts sur un système
    // sensible à la casse. Leurs sessions se seraient groupées ensemble, et
    // masquer l'un aurait masqué l'autre.
    //
    // Le test porte sur le prédicat, pas sur un vrai arbre disque : sur
    // Windows on ne PEUT pas créer deux dossiers ne différant que par la casse,
    // donc un test de bout en bout ne prouverait rien ici — et sur Linux il
    // prouverait autre chose. Le jumeau web est
    // apps/web/src/lib/project-key.ts.
    expect(projectKeyOf('/srv/App')).not.toBe(projectKeyOf('/srv/app'));
    // Windows, lui, se replie bien : c'est le même dossier écrit autrement.
    expect(projectKeyOf('C:\\Dev\\App\\')).toBe(projectKeyOf('c:/dev/app'));
    // Un PARTAGE RÉSEAU aussi (revue Codex, 26/08) : `\\serveur\part` est un
    // chemin Windows, insensible à la casse, même s'il n'a pas de lettre de
    // lecteur. Les workspaces l'acceptent depuis toujours.
    expect(projectKeyOf('\\\\serveur\\part\\App')).toBe(projectKeyOf('//SERVEUR/part/app'));
    // Et il ne se confond pas avec un chemin POSIX.
    expect(projectKeyOf('//serveur/part/App')).not.toBe(projectKeyOf('/serveur/part/app'));
  });

  it('RENOMMER un projet change le nom que les agents entendent', async () => {
    // Sans ça, « modifie le portail client » ne désignerait rien pour un agent
    // alors que l'onglet affiche ce nom-là — l'écran et le prompt parleraient
    // de la même chose avec deux vocabulaires.
    const projet = `${racine}/dev/calorie-counter`;

    await db.insert(codeProjects).values({
      entityId: seed.entityId,
      projectPath: projet,
      displayName: 'Compteur de calories',
    });
    _resetProjectsCacheForTests();

    try {
      const projects = await listCodeProjectsForContext(db as RunnerDeps['db'], seed.entityId);
      const p = projects.find((x) => x.path === projet);
      expect(p?.name, 'les agents entendent encore le nom du dossier').toBe('Compteur de calories');
      // Le CHEMIN reste la vérité : c'est par lui que l'agent trouve l'app.
      expect(p?.path).toBe(projet);
    } finally {
      await db.delete(codeProjects).where(eq(codeProjects.projectPath, projet));
      _resetProjectsCacheForTests();
    }
  });

  it('le coffre d’un scribe apparaît AUSSI — plus rien n’est deviné', async () => {
    // Ce test disait l'inverse jusqu'au 26/08 : le coffre d'un agent
    // non-développeur était filtré. Il ne l'est plus, et c'est le point de la
    // décision — ce qui l'en sort maintenant, c'est le masquage, un geste
    // explicite et réversible.
    const coffre = norm(await mkdtemp(join(tmpdir(), 'nodal-coexist-')));
    await mkdir(join(coffre, 'notes-app'), { recursive: true });
    await writeFile(join(coffre, 'notes-app', 'build.py'), 'print(1)');

    const [scribe] = await db
      .insert(agents)
      .values({
        entityId: seed.entityId,
        name: 'Scribe voisin',
        slug: `scribe-voisin-${Date.now()}`,
        personality: 'x',
      })
      .returning();
    await db.insert(agentWorkspaces).values({
      entityId: seed.entityId,
      agentId: scribe!.id,
      label: 'Coffre',
      path: coffre,
    });
    const [jobScribe] = await db
      .insert(agentJobs)
      .values({
        entityId: seed.entityId,
        agentId: scribe!.id,
        status: 'completed',
        channel: 'api',
        task: 'notes',
      })
      .returning();
    await db.insert(toolCalls).values({
      entityId: seed.entityId,
      jobId: jobScribe!.id,
      toolName: 'file_write',
      toolInput: { path: `${coffre}/notes-app/build.py` },
      toolOutput: '{"ok":true}',
    });

    try {
      const projects = await listCodeProjectsForContext(db as RunnerDeps['db'], seed.entityId);
      const notes = projects.find((p) => p.name === 'notes-app');
      expect(notes, 'un dossier attaché n’a produit aucun projet').toBeTruthy();
      expect(notes!.owners).toEqual(['Scribe voisin']);
      // Les autres projets sont toujours là.
      expect(projects.some((p) => p.name === 'calorie-counter')).toBe(true);
    } finally {
      await db.delete(toolCalls).where(eq(toolCalls.jobId, jobScribe!.id));
      await db.delete(agentWorkspaces).where(eq(agentWorkspaces.agentId, scribe!.id));
      await rm(coffre, { recursive: true, force: true });
    }
  });

  it('un développeur qui DÉLÈGUE reste l’auteur : le projet existe même si le worker n’a pas le skill', async () => {
    // Les deux vues doivent juger la même chose (revue du 25/08, 3e tour).
    // L'onglet Code regarde toute la CHAÎNE : si un développeur est quelque
    // part dedans, le pipeline lui appartient. Ce module ne regardait que
    // l'auteur de l'appel — donc, quand un développeur déléguait à un worker
    // ne portant pas encore le skill, l'onglet montrait le travail pendant que
    // le prompt taisait le projet. Deux règles pour une même question.
    await mkdir(join(racine, 'dev', 'delegue-app'), { recursive: true });
    await writeFile(join(racine, 'dev', 'delegue-app', 'index.html'), '<!doctype html>');

    const [worker] = await db
      .insert(agents)
      .values({
        entityId: seed.entityId,
        name: 'Worker sans skill',
        slug: `worker-${Date.now()}`,
        personality: 'x',
      })
      .returning();

    // Le job du LEAD (développeur) délègue à celui du worker.
    const [jobLead] = await db
      .insert(agentJobs)
      .values({
        entityId: seed.entityId,
        agentId: leadAgentId,
        status: 'completed',
        channel: 'api',
        task: 'construis l’app',
      })
      .returning();
    const [jobWorker] = await db
      .insert(agentJobs)
      .values({
        entityId: seed.entityId,
        agentId: worker!.id,
        parentJobId: jobLead!.id,
        status: 'completed',
        channel: 'api',
        task: 'écris les fichiers',
      })
      .returning();

    // C'est le worker qui écrit, et il n'a aucun skill.
    await db.insert(toolCalls).values({
      entityId: seed.entityId,
      jobId: jobWorker!.id,
      toolName: 'file_write',
      toolInput: { path: `${racine}/dev/delegue-app/index.html` },
      toolOutput: '{"ok":true}',
    });

    try {
      const projects = await listCodeProjectsForContext(db as RunnerDeps['db'], seed.entityId);
      expect(
        projects.some((p) => p.name === 'delegue-app'),
        'le travail délégué par un développeur a disparu du contexte',
      ).toBe(true);
    } finally {
      await db.delete(toolCalls).where(eq(toolCalls.jobId, jobWorker!.id));
      await rm(join(racine, 'dev', 'delegue-app'), { recursive: true, force: true });
    }
  });

  it('un dossier attaché couvre TOUT ce qu’il contient, quel que soit l’auteur', async () => {
    // Attacher `\\dev` fait de `\\dev\\calorie-counter` un projet. Le dossier
    // marque un PÉRIMÈTRE, donc tout ce qui vit dedans en fait partie — y
    // compris le travail d'un agent qui n'a rien d'un développeur.
    //
    // C'est ce qui rend la règle prévisible : le propriétaire n'a pas à se
    // demander qui a écrit, seulement où.
    await mkdir(join(racine, 'dev', 'niche-app'), { recursive: true });
    await writeFile(join(racine, 'dev', 'niche-app', 'notes.py'), 'print(1)');

    const [scribe] = await db
      .insert(agents)
      .values({
        entityId: seed.entityId,
        name: 'Scribe niché',
        slug: `scribe-niche-${Date.now()}`,
        personality: 'x',
      })
      .returning();
    const [jobScribe] = await db
      .insert(agentJobs)
      .values({
        entityId: seed.entityId,
        agentId: scribe!.id,
        status: 'completed',
        channel: 'api',
        task: 'notes',
      })
      .returning();
    await db.insert(toolCalls).values({
      entityId: seed.entityId,
      jobId: jobScribe!.id,
      toolName: 'file_write',
      toolInput: { path: `${racine}/dev/niche-app/notes.py` },
      toolOutput: '{"ok":true}',
    });

    try {
      const projects = await listCodeProjectsForContext(db as RunnerDeps['db'], seed.entityId);
      expect(
        projects.some((p) => p.name === 'niche-app'),
        'un sous-dossier du dossier attaché n’est pas devenu un projet',
      ).toBe(true);
      // Et c'est bien le SOUS-DOSSIER, jamais le dossier attaché lui-même.
      expect(projects.some((p) => p.path === `${racine}/dev`)).toBe(false);
    } finally {
      await db.delete(toolCalls).where(eq(toolCalls.jobId, jobScribe!.id));
      await rm(join(racine, 'dev', 'niche-app'), { recursive: true, force: true });
    }
  });

  it('un espace voisin ne voit QUE ses propres projets', async () => {
    // Le cloisonnement par entité. Sans lui, le prompt système d'un espace
    // annoncerait les projets d'un autre, détenteurs compris.
    const dossier = norm(await mkdtemp(join(tmpdir(), 'nodal-notdev-')));
    await mkdir(join(dossier, 'coffre'), { recursive: true });
    await writeFile(join(dossier, 'coffre', 'script.py'), 'print(1)');

    const [autreEntite] = await db
      .insert(entities)
      .values({ userId: seed.userId, name: 'Espace sans dev', slug: `sans-dev-${Date.now()}` })
      .returning();
    const [scribe] = await db
      .insert(agents)
      .values({
        entityId: autreEntite!.id,
        name: 'Scribe',
        slug: `scribe-${Date.now()}`,
        personality: 'x',
      })
      .returning();
    await db.insert(agentWorkspaces).values({
      entityId: autreEntite!.id,
      agentId: scribe!.id,
      label: 'Coffre',
      path: dossier,
    });
    const [jobScribe] = await db
      .insert(agentJobs)
      .values({
        entityId: autreEntite!.id,
        agentId: scribe!.id,
        status: 'completed',
        channel: 'api',
        task: 'notes',
      })
      .returning();
    await db.insert(toolCalls).values({
      entityId: autreEntite!.id,
      jobId: jobScribe!.id,
      toolName: 'file_write',
      toolInput: { path: `${dossier}/coffre/script.py` },
      toolOutput: '{"ok":true}',
    });

    try {
      const projects = await listCodeProjectsForContext(db as RunnerDeps['db'], autreEntite!.id);
      // Son propre projet, et LUI SEUL.
      expect(projects.map((p) => p.name)).toEqual(['coffre']);
      expect(
        projects.some((p) => p.path.startsWith(racine)),
        'les projets de l’espace voisin ont fuité dans ce contexte',
      ).toBe(false);
    } finally {
      await rm(dossier, { recursive: true, force: true });
    }
  });

  it('une entité sans workspace rend une liste vide (jamais une exception)', async () => {
    const projects = await listCodeProjectsForContext(
      db as RunnerDeps['db'],
      '00000000-0000-0000-0000-0000000000ff',
    );
    expect(projects).toEqual([]);
  });
});
