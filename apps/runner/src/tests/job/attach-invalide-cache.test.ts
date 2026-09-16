// attach-invalide-cache.test.ts — ATTACHER un dossier change l'identité des
// projets, et le cache de 60 s ne doit pas rendre l'ancienne.
//
// Revue Codex de la dette de la PR #75, passe 4, constat 1. La signature du
// cache ne portait que les projets DÉCLARÉS. Attacher un dossier imbriqué en
// est un autre geste de propriétaire, dans une autre table : `w` attaché, une
// écriture dans `w/app/src/module/a.ts` fait annoncer `w/app` ; le propriétaire
// attache ensuite `w/app/src` et le masque. Pendant la minute qui suit, les
// agents s'entendaient encore annoncer `w/app`, que le filtre de masquage ne
// reconnaît pas comme appartenant au sous-arbre masqué — il compare des clés,
// et un PARENT n'est pas un enfant.
//
// C'est le même défaut que la revue du 26/08 avait tranché pour la visibilité,
// et que la passe 3 avait tranché pour les déclarations, atteint par la
// troisième porte. Ce test ne vide JAMAIS le cache entre les deux appels : tout
// son objet est là.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import { eq, agents, agentWorkspaces, agentJobs, toolCalls } from '@nodal-agents/db';
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
let agentId = '';
let jobId = '';
const norm = (p: string) => p.replace(/\\/g, '/');

beforeAll(async () => {
  db = (await spinUpTestDb()).db;
  seed = await seedMinimal(db);
  racine = norm(await mkdtemp(join(tmpdir(), 'nodal-attach-cache-')));
  await mkdir(join(racine, 'app', 'src', 'module'), { recursive: true });
  await writeFile(join(racine, 'app', 'src', 'module', 'a.ts'), 'export {}');

  const [ag] = await db
    .insert(agents)
    .values({
      entityId: seed.entityId,
      name: 'Agent cache',
      slug: `cache-${Date.now()}`,
      personality: 'x',
    })
    .returning();
  agentId = ag!.id;
  await db.insert(agentWorkspaces).values({
    entityId: seed.entityId,
    agentId,
    label: 'w',
    path: racine,
  });

  const [job] = await db
    .insert(agentJobs)
    .values({
      entityId: seed.entityId,
      agentId,
      status: 'completed',
      channel: 'api',
      task: 'écrire',
    })
    .returning();
  jobId = job!.id;
  await db.insert(toolCalls).values({
    entityId: seed.entityId,
    jobId,
    toolName: 'file_write',
    toolInput: { path: `${racine}/app/src/module/a.ts` },
    toolOutput: '{"ok":true}',
  });
  _resetProjectsCacheForTests();
});

afterAll(async () => {
  if (racine) await rm(racine, { recursive: true, force: true });
  _resetProjectsCacheForTests();
});

describe('le cache du scan et les gestes du propriétaire @cap:travailler-sur-des-fichiers/moteur', () => {
  it('attacher PUIS masquer un dossier imbriqué prend effet tout de suite', async () => {
    // Le cache est rempli avec l'identité d'avant : le projet est `app`.
    const avant = await listCodeProjectsForContext(db as RunnerDeps['db'], seed.entityId);
    expect(avant.map((p) => p.path)).toEqual([`${racine}/app`]);

    const [wsNiche] = await db
      .insert(agentWorkspaces)
      .values({
        entityId: seed.entityId,
        agentId,
        label: 'src',
        path: `${racine}/app/src`,
        hiddenFromCode: true,
      })
      .returning();

    // AUCUN vidage de cache ici : c'est tout l'objet du test.
    const apres = await listCodeProjectsForContext(db as RunnerDeps['db'], seed.entityId);
    expect(
      apres.some((p) => p.path === `${racine}/app`),
      'le parent d’un dossier masqué reste annoncé aux agents',
    ).toBe(false);

    await db.delete(agentWorkspaces).where(eq(agentWorkspaces.id, wsNiche!.id));
  });
});
