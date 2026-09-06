// backfill-registered-projects.test.ts — le registre se remplit tout seul,
// y compris pour l'activité d'AVANT (P5b).
//
// Les projets de l'onglet Code sont dérivés de `tool_calls` : ce test sème des
// écritures réelles (un `file_write` Nodal en chemin relatif, un `cli:Edit` en
// chemin absolu) sous des dossiers attachés réels, et relit `code_projects` et
// `agent_jobs` après le backfill. Deux enfants portent un manifeste, un
// troisième non ; un dossier attaché masqué par le propriétaire est sauté ; un
// dossier détenu par DEUX agents ne nomme aucun responsable ; les jobs qui ont
// écrit sont rattachés ; une seconde passe ne change rien.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import { agentJobs, agentWorkspaces, agents, codeProjects, toolCalls, eq } from '@nodal-agents/db';
import { normalizePath, projectKey } from '@nodal-agents/shared';
import { backfillRegisteredProjects } from '../../bootstrap/backfill-registered-projects.ts';
import { _resetProjectsCacheForTests } from '../../job/code-projects.ts';

let db: TestDb;
let seed: Awaited<ReturnType<typeof seedMinimal>>;
let racine = '';
let dev = '';
let dev2 = '';
let coffre = '';
let agent2Id = '';
let job2Id = '';

beforeAll(async () => {
  const res = await spinUpTestDb();
  db = res.db;
  seed = await seedMinimal(db);
  racine = normalizePath(realpathSync.native(await mkdtemp(join(tmpdir(), 'nodal-backfill-reg-'))));
  dev = `${racine}/dev`;
  dev2 = `${racine}/dev2`;
  coffre = `${racine}/coffre`;
  // Deux enfants à manifeste (package.json, .git), un sans.
  await mkdir(`${dev}/app1/src`, { recursive: true });
  await writeFile(`${dev}/app1/package.json`, '{}');
  await mkdir(`${dev}/app2/.git`, { recursive: true });
  await mkdir(`${dev}/vrac`, { recursive: true });
  // Un second terrain, détenu par le second agent seul, avec un projet.
  await mkdir(`${dev2}/app3`, { recursive: true });
  await writeFile(`${dev2}/app3/pyproject.toml`, '');
  // Un dossier attaché MASQUÉ, avec un enfant à manifeste et une écriture.
  await mkdir(`${coffre}/secret`, { recursive: true });
  await writeFile(`${coffre}/secret/package.json`, '{}');

  const [agent2] = await db
    .insert(agents)
    .values({
      entityId: seed.entityId,
      name: 'Second Agent',
      slug: `second-agent-${Date.now()}`,
      personality: 'x',
    })
    .returning({ id: agents.id });
  agent2Id = agent2!.id;
  const [job2] = await db
    .insert(agentJobs)
    .values({ entityId: seed.entityId, agentId: agent2Id, channel: 'api', task: 'app3' })
    .returning({ id: agentJobs.id });
  job2Id = job2!.id;

  await db.insert(agentWorkspaces).values([
    { entityId: seed.entityId, agentId: seed.agentId, label: 'Dev', path: dev },
    // `dev` est détenu par les DEUX agents : personne n'est « le » responsable.
    { entityId: seed.entityId, agentId: agent2Id, label: 'Dev', path: dev },
    { entityId: seed.entityId, agentId: agent2Id, label: 'Dev2', path: dev2 },
    {
      entityId: seed.entityId,
      agentId: seed.agentId,
      label: 'Coffre',
      path: coffre,
      hiddenFromCode: true,
    },
  ]);

  // Les écritures, sur les jobs semés : le scan lit l'auteur par le job, et un
  // chemin relatif se résout chez lui (par label quand il en a plusieurs).
  await db.insert(toolCalls).values([
    {
      entityId: seed.entityId,
      jobId: seed.jobId,
      toolName: 'file_write',
      toolInput: { path: 'Dev/app1/src/index.ts', content: '' },
      toolOutput: '{"ok":true}',
      createdAt: new Date('2026-08-01T10:00:00.000Z'),
    },
    {
      entityId: seed.entityId,
      jobId: seed.jobId,
      toolName: 'file_write',
      toolInput: { path: 'Dev/app1/src/util.ts', content: '' },
      toolOutput: '{"ok":true}',
      createdAt: new Date('2026-08-02T10:00:00.000Z'),
    },
    {
      entityId: seed.entityId,
      jobId: seed.jobId,
      toolName: 'cli:Edit',
      toolInput: { file_path: `${dev}/app2/main.py` },
      toolOutput: '{"ok":true}',
      createdAt: new Date('2026-08-03T10:00:00.000Z'),
    },
    {
      entityId: seed.entityId,
      jobId: seed.jobId,
      toolName: 'file_write',
      toolInput: { path: 'Dev/vrac/note.md', content: '' },
      toolOutput: '{"ok":true}',
      createdAt: new Date('2026-08-04T10:00:00.000Z'),
    },
    {
      entityId: seed.entityId,
      jobId: seed.jobId,
      toolName: 'file_write',
      toolInput: { path: 'Coffre/secret/index.ts', content: '' },
      toolOutput: '{"ok":true}',
      createdAt: new Date('2026-08-05T10:00:00.000Z'),
    },
    {
      entityId: seed.entityId,
      jobId: job2Id,
      toolName: 'file_write',
      toolInput: { path: 'Dev2/app3/main.py', content: '' },
      toolOutput: '{"ok":true}',
      createdAt: new Date('2026-08-06T10:00:00.000Z'),
    },
  ]);
  // `app2` est DÉJÀ au registre, déclaré depuis Spaces : le backfill n'y touche
  // pas, mais rattache son historique comme celui des projets qu'il déclare.
  await db.insert(codeProjects).values({
    entityId: seed.entityId,
    projectPath: `${dev}/app2`,
    projectKey: projectKey(`${dev}/app2`),
    displayName: 'App deux',
    agentId: seed.agentId,
    registeredAt: new Date('2026-09-01T10:00:00.000Z'),
    registeredFrom: 'spaces',
  });
  _resetProjectsCacheForTests();
});

afterAll(async () => {
  try {
    await rm(racine, { recursive: true, force: true });
  } catch {
    /* jetable */
  }
});

const ligne = async (path: string) => {
  const [row] = await db
    .select({
      id: codeProjects.id,
      projectPath: codeProjects.projectPath,
      kind: codeProjects.kind,
      agentId: codeProjects.agentId,
      displayName: codeProjects.displayName,
      registeredAt: codeProjects.registeredAt,
      registeredFrom: codeProjects.registeredFrom,
      registeredJobId: codeProjects.registeredJobId,
    })
    .from(codeProjects)
    .where(eq(codeProjects.projectKey, projectKey(path)));
  return row ?? null;
};

const projetDuJob = async (jobId: string): Promise<string | null> => {
  const [row] = await db
    .select({ projectId: agentJobs.projectId })
    .from(agentJobs)
    .where(eq(agentJobs.id, jobId));
  return row?.projectId ?? null;
};

describe('backfillRegisteredProjects', () => {
  it('déclare les projets dérivés à manifeste, rattache leurs jobs, saute le reste, et dit ses compteurs', async () => {
    const avant = new Date();
    const report = await backfillRegisteredProjects(db);

    // app1 et app3 déclarés, app2 déjà là ; vrac (sans manifeste) et secret
    // (masqué) sautés.
    expect(report).toEqual({
      registered: 2,
      jobsAttached: 2,
      skipped: { missing: 0, noMarker: 1, hidden: 1, alreadyRegistered: 1 },
    });

    const app1 = await ligne(`${dev}/app1`);
    expect(app1).toMatchObject({
      projectPath: `${dev}/app1`,
      kind: 'code',
      // Deux détenteurs : aucun responsable désigné (revue Codex, passe 32).
      agentId: null,
      displayName: null,
      registeredFrom: 'conversation',
      registeredJobId: null,
    });
    // L'instant de la déclaration, pas la dernière activité.
    expect(app1!.registeredAt!.getTime()).toBeGreaterThanOrEqual(avant.getTime() - 1000);

    // Déclaré depuis Spaces : intact — nom, agent, origine, date.
    const app2 = await ligne(`${dev}/app2`);
    expect(app2).toMatchObject({
      displayName: 'App deux',
      agentId: seed.agentId,
      registeredFrom: 'spaces',
      registeredAt: new Date('2026-09-01T10:00:00.000Z'),
    });

    // Un seul détenteur : c'est lui.
    const app3 = await ligne(`${dev2}/app3`);
    expect(app3).toMatchObject({ agentId: agent2Id, registeredFrom: 'conversation' });

    expect(await ligne(`${dev}/vrac`)).toBeNull();
    expect(await ligne(`${coffre}/secret`)).toBeNull();
    expect(await ligne(dev)).toBeNull();

    // L'historique rattaché : le job semé a écrit dans app1 ET app2 — le
    // premier gagne, et le scan rend le plus actif d'abord (app2, 03/08) ; app2
    // était déclaré d'avance, son historique se rattache quand même.
    expect(await projetDuJob(seed.jobId)).toBe(app2!.id);
    expect(await projetDuJob(job2Id)).toBe(app3!.id);
  });

  it('une seconde passe ne déclare rien, ne rattache rien, et ne retouche aucune ligne', async () => {
    const avant = await ligne(`${dev}/app1`);
    const jobAvant = await projetDuJob(seed.jobId);
    _resetProjectsCacheForTests();

    const report = await backfillRegisteredProjects(db);

    expect(report).toEqual({
      registered: 0,
      jobsAttached: 0,
      skipped: { missing: 0, noMarker: 1, hidden: 1, alreadyRegistered: 3 },
    });
    expect(await ligne(`${dev}/app1`)).toEqual(avant);
    expect(await projetDuJob(seed.jobId)).toBe(jobAvant);
    const declarees = await db
      .select({ id: codeProjects.id })
      .from(codeProjects)
      .where(eq(codeProjects.entityId, seed.entityId));
    expect(declarees).toHaveLength(3);
  });
});
