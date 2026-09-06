// backfill-registered-projects.test.ts — le registre se remplit tout seul,
// y compris pour l'activité d'AVANT (P5b).
//
// Les projets de l'onglet Code sont dérivés de `tool_calls` : ce test sème des
// écritures réelles (un `file_write` Nodal en chemin relatif, un `cli:Edit` en
// chemin absolu) sous un dossier attaché réel, et relit `code_projects` après
// le backfill. Deux enfants portent un manifeste, un troisième non ; un
// dossier attaché masqué par le propriétaire est sauté ; une seconde passe ne
// change rien.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import { agentWorkspaces, codeProjects, toolCalls, eq } from '@nodal-agents/db';
import { normalizePath, projectKey } from '@nodal-agents/shared';
import { backfillRegisteredProjects } from '../../bootstrap/backfill-registered-projects.ts';
import { _resetProjectsCacheForTests } from '../../job/code-projects.ts';

let db: TestDb;
let seed: Awaited<ReturnType<typeof seedMinimal>>;
let racine = '';
let dev = '';
let coffre = '';

beforeAll(async () => {
  const res = await spinUpTestDb();
  db = res.db;
  seed = await seedMinimal(db);
  racine = normalizePath(realpathSync.native(await mkdtemp(join(tmpdir(), 'nodal-backfill-reg-'))));
  dev = `${racine}/dev`;
  coffre = `${racine}/coffre`;
  // Deux enfants à manifeste (package.json, .git), un sans.
  await mkdir(`${dev}/app1/src`, { recursive: true });
  await writeFile(`${dev}/app1/package.json`, '{}');
  await mkdir(`${dev}/app2/.git`, { recursive: true });
  await mkdir(`${dev}/vrac`, { recursive: true });
  // Un dossier attaché MASQUÉ, avec un enfant à manifeste et une écriture.
  await mkdir(`${coffre}/secret`, { recursive: true });
  await writeFile(`${coffre}/secret/package.json`, '{}');

  await db.insert(agentWorkspaces).values([
    { entityId: seed.entityId, agentId: seed.agentId, label: 'Dev', path: dev },
    {
      entityId: seed.entityId,
      agentId: seed.agentId,
      label: 'Coffre',
      path: coffre,
      hiddenFromCode: true,
    },
  ]);

  // Les écritures, sur le job semé (agent = seed.agentId) : le scan lit
  // l'auteur par le job, et un chemin relatif se résout chez lui.
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
  ]);
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

describe('backfillRegisteredProjects', () => {
  it('déclare les projets dérivés à manifeste, saute le reste, et dit ses compteurs', async () => {
    const report = await backfillRegisteredProjects(db);

    // app1 et app2 déclarés ; vrac (sans manifeste) et secret (masqué) sautés.
    expect(report).toEqual({ registered: 2, skipped: 2 });

    const app1 = await ligne(`${dev}/app1`);
    expect(app1).toMatchObject({
      projectPath: `${dev}/app1`,
      kind: 'code',
      agentId: seed.agentId,
      displayName: null,
      registeredFrom: 'conversation',
      registeredJobId: null,
    });
    // La DERNIÈRE activité, pas l'instant du boot.
    expect(app1!.registeredAt).toEqual(new Date('2026-08-02T10:00:00.000Z'));

    const app2 = await ligne(`${dev}/app2`);
    expect(app2).toMatchObject({ agentId: seed.agentId, registeredFrom: 'conversation' });
    expect(app2!.registeredAt).toEqual(new Date('2026-08-03T10:00:00.000Z'));

    expect(await ligne(`${dev}/vrac`)).toBeNull();
    expect(await ligne(`${coffre}/secret`)).toBeNull();
    expect(await ligne(dev)).toBeNull();
  });

  it('une seconde passe ne déclare rien et ne retouche aucune ligne', async () => {
    const avant = await ligne(`${dev}/app1`);
    _resetProjectsCacheForTests();

    const report = await backfillRegisteredProjects(db);

    expect(report).toEqual({ registered: 0, skipped: 4 });
    expect(await ligne(`${dev}/app1`)).toEqual(avant);
    const declarees = await db
      .select({ id: codeProjects.id })
      .from(codeProjects)
      .where(eq(codeProjects.entityId, seed.entityId));
    expect(declarees).toHaveLength(2);
  });
});
