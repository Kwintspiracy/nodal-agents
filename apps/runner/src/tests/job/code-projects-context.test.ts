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

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import {
  agents,
  agentWorkspaces,
  agentJobs,
  agentSkills,
  agentSkillAssignments,
  entities,
  toolCalls,
} from '@nodal-agents/db';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RunnerDeps } from '../../deps.ts';
import { listCodeProjectsForContext } from '../../job/code-projects.ts';

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

  // Le skill « dev » du catalogue : un projet naît du travail d'un
  // DÉVELOPPEUR, pas de n'importe quelle écriture de fichier. Même règle
  // d'identité que l'onglet Code, pour que les deux vues ne se contredisent
  // jamais (revue du 25/08).
  const [devSkillRow] = await db
    .insert(agentSkills)
    .values({
      entityId: seed.entityId,
      name: 'Software development',
      slug: 'dev',
      content: 'test dev skill',
      createdBy: 'system',
    })
    .returning();

  for (const agentId of [devAgentId, leadAgentId]) {
    await db.insert(agentWorkspaces).values({
      entityId: seed.entityId,
      agentId,
      label: 'Dev',
      path: ws,
    });
    await db.insert(agentSkillAssignments).values({
      entityId: seed.entityId,
      agentId,
      skillId: devSkillRow!.id,
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
