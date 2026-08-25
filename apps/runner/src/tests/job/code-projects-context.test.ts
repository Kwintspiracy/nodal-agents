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
