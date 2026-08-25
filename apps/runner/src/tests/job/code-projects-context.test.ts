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
import { eq, agents, agentWorkspaces, agentJobs, entities, toolCalls } from '@nodal-agents/db';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RunnerDeps } from '../../deps.ts';
import {
  listCodeProjectsForContext,
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

  // Le dossier partagé est COCHÉ « développement » — c'est la seule chose qui
  // fait exister un projet depuis le 26/08. Ni l'extension des fichiers, ni
  // les skills des agents n'entrent dans le calcul.
  for (const agentId of [devAgentId, leadAgentId]) {
    await db.insert(agentWorkspaces).values({
      entityId: seed.entityId,
      agentId,
      label: 'Dev',
      path: ws,
      isDevFolder: true,
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

  it('dans une entité QUI A des développeurs, le workspace d’un non-dev ne produit rien', async () => {
    // Le test jumeau ci-dessous sort par le raccourci « aucun développeur dans
    // l'entité » : il ne touche donc jamais le filtre des workspaces lui-même
    // (constat de la revue — en retirant ce filtre, il passait quand même).
    // Ici l'entité a deux développeurs, et le scribe cohabite avec eux : seul
    // le filtre par identité empêche son coffre de devenir un projet.
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
      expect(
        projects.some((p) => p.name === 'notes-app'),
        'le workspace d’un non-développeur a produit un projet',
      ).toBe(false);
      // Les vrais projets, eux, sont toujours là.
      expect(projects.map((p) => p.name).sort()).toEqual(['calorie-counter', 'water-intake']);
    } finally {
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

  it('un dossier coché couvre TOUT ce qu’il contient, quel que soit l’auteur', async () => {
    // La règle demandée par Quentin le 26/08 : cocher `\\dev` fait de
    // `\\dev\\calorie-counter` un projet. La case marque un PÉRIMÈTRE, donc
    // tout ce qui vit dedans en fait partie — y compris le travail d'un agent
    // qui n'a rien d'un développeur.
    //
    // C'est délibéré et c'est ce qui rend la règle prévisible : le
    // propriétaire n'a pas à se demander qui a écrit, seulement où. Un dossier
    // qu'il ne veut pas voir ici, il ne le range pas sous un dossier coché.
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
        'un sous-dossier du dossier coché n’est pas devenu un projet',
      ).toBe(true);
      // Et c'est bien le SOUS-DOSSIER, jamais le dossier coché lui-même.
      expect(projects.some((p) => p.path === `${racine}/dev`)).toBe(false);
    } finally {
      await db.delete(toolCalls).where(eq(toolCalls.jobId, jobScribe!.id));
      await rm(join(racine, 'dev', 'niche-app'), { recursive: true, force: true });
    }
  });

  it('le workspace d’un agent NON-développeur ne produit AUCUN projet', async () => {
    // La convergence avec l'onglet Code (revue du 25/08). Ce module dit aux
    // agents quels projets existent ; l'onglet les montre au propriétaire. Si
    // seul l'onglet filtrait par identité, le prompt système annoncerait à
    // tous les agents des projets invisibles dans l'interface — un coffre de
    // notes, des workflows d'images — avec leurs détenteurs, et personne ne
    // pourrait voir le désaccord.
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
    // Un VRAI fichier de code, écrit par un agent qui n'est pas développeur :
    // c'est exactement le coffre Obsidian de juillet.
    await db.insert(toolCalls).values({
      entityId: autreEntite!.id,
      jobId: jobScribe!.id,
      toolName: 'file_write',
      toolInput: { path: `${dossier}/coffre/script.py` },
      toolOutput: '{"ok":true}',
    });

    try {
      const projects = await listCodeProjectsForContext(db as RunnerDeps['db'], autreEntite!.id);
      expect(
        projects,
        'un projet a été annoncé aux agents alors que l’onglet Code ne le montre pas',
      ).toEqual([]);
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
