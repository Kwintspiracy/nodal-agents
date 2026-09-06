// attach-seam.test.ts — le CÂBLAGE du registre, par le VRAI seam.
//
// `attach.test.ts` prouve la RÈGLE ; ce fichier prouve qu'elle est BRANCHÉE.
// La distinction a coûté quatre fois au dépôt (lot du 27/08) : un test qui
// appelle la fonction directement reste vert quand le site d'appel disparaît.
// Ici, rien n'appelle `attachProductionToProject` : on passe par `executeTool`
// avec le vrai `file_write`, un workspace temporaire réel, et on relit les
// TROIS traces — le fichier sur le disque, la ligne `tool_calls`, le
// `project_id` du job.

import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import { agentJobs, codeProjects, toolCalls, eq } from '@nodal-agents/db';
import { normalizePath, projectKey } from '@nodal-agents/shared';
import { createToolRegistry } from '../../registry';
import { registerBuiltins } from '../../builtin';
import { executeTool } from '../../execute';
import type { ExecuteOptions, ToolContext } from '../../types';

let db: TestDb;
let seed: Awaited<ReturnType<typeof seedMinimal>>;
let racine = '';

const registry = createToolRegistry();
registerBuiltins(registry);

beforeAll(async () => {
  const res = await spinUpTestDb();
  db = res.db;
  seed = await seedMinimal(db);
});

beforeEach(async () => {
  // `realpath` : sur Windows, `tmpdir()` peut rendre la forme courte 8.3 alors
  // que les outils résolvent en forme longue. Le terrain est donc pris sous sa
  // forme réelle, comme un propriétaire qui attache un dossier existant.
  racine = normalizePath(realpathSync.native(await mkdtemp(join(tmpdir(), 'nodal-attach-seam-'))));
});

afterEach(async () => {
  try {
    await rm(racine, { recursive: true, force: true });
  } catch {
    /* jetable */
  }
});

async function jobNeuf(): Promise<string> {
  const [job] = await db
    .insert(agentJobs)
    .values({ entityId: seed.entityId, agentId: seed.agentId, channel: 'api', task: 'seam' })
    .returning({ id: agentJobs.id });
  if (!job) throw new Error('insert job');
  return job.id;
}

async function projetEnregistre(path: string): Promise<string> {
  const [row] = await db
    .insert(codeProjects)
    .values({
      entityId: seed.entityId,
      projectPath: path,
      projectKey: projectKey(path),
      displayName: 'Projet X',
      agentId: seed.agentId,
      registeredAt: new Date(),
      registeredFrom: 'spaces',
    })
    .returning({ id: codeProjects.id });
  if (!row) throw new Error('insert projet');
  return row.id;
}

function ctx(workspacePath: string, jobId: string): ToolContext {
  return {
    db,
    entityId: seed.entityId,
    agentId: seed.agentId,
    jobId,
    jobChatId: null,
    workspaces: [{ label: 'terrain', path: workspacePath }],
    turn: 1,
  } as unknown as ToolContext;
}

function options(): ExecuteOptions {
  return {
    approvalRules: [
      {
        id: 'rule-file-write',
        toolName: 'file_write',
        action: 'auto_approve',
        agentId: seed.agentId,
        entityId: seed.entityId,
      },
    ] as ExecuteOptions['approvalRules'],
    onApprovalRequired: async () => {},
  };
}

async function projetDuJob(jobId: string): Promise<string | null> {
  const [row] = await db
    .select({ projectId: agentJobs.projectId })
    .from(agentJobs)
    .where(eq(agentJobs.id, jobId));
  if (!row) throw new Error('job introuvable');
  return row.projectId;
}

describe('le registre au seam d’exécution', () => {
  it('file_write dans un projet enregistré : le fichier, la ligne d’audit ET le rattachement', async () => {
    const terrain = racine;
    // Un manifeste : le terrain lui-même est le projet, comme un dépôt attaché.
    await writeFile(join(terrain, 'package.json'), '{}');
    const projetPath = `${terrain}/projet-x`;
    await mkdir(projetPath, { recursive: true });
    const projetId = await projetEnregistre(projetPath);
    const jobId = await jobNeuf();

    const tool = registry.get('file_write');
    if (!tool) throw new Error('file_write absent du registre');
    const res = await executeTool(
      tool,
      { path: 'projet-x/src/a.ts', content: 'export const a = 1;\n', create_dirs: true },
      ctx(terrain, jobId),
      options(),
    );
    expect(res.outcome === 'error' ? res.error : res.outcome).toBe('success');

    // 1. Le fichier est sur le disque, avec son contenu.
    expect(await readFile(join(projetPath, 'src', 'a.ts'), 'utf8')).toBe('export const a = 1;\n');

    // 2. La ligne d'audit existe pour ce job.
    const audit = await db
      .select({ toolName: toolCalls.toolName })
      .from(toolCalls)
      .where(eq(toolCalls.jobId, jobId));
    expect(audit.map((r) => r.toolName)).toContain('file_write');

    // 3. Le job porte le projet — la trace qui n'existait pas avant P5.
    expect(await projetDuJob(jobId)).toBe(projetId);
  });

  it('un chemin HORS terrain reste refusé, et n’attache rien', async () => {
    const terrain = racine;
    await writeFile(join(terrain, 'package.json'), '{}');
    // Le projet enregistré existe : si le rattachement se faisait sans regarder
    // la cible, ce test le verrait.
    await projetEnregistre(terrain);
    const jobId = await jobNeuf();

    const dehors = normalizePath(join(racine, '..', 'hors-terrain.txt'));
    const tool = registry.get('file_write');
    if (!tool) throw new Error('file_write absent du registre');
    const res = await executeTool(
      tool,
      { path: dehors, content: 'interdit' },
      ctx(terrain, jobId),
      options(),
    );

    // L'outil refuse comme aujourd'hui : P5 ne change RIEN au périmètre.
    expect(res.outcome).toBe('success');
    if (res.outcome !== 'success') return;
    const output = res.output as { ok: boolean; reason?: string };
    expect(output.ok).toBe(false);
    expect(output.reason ?? '').not.toBe('');

    // Le fichier n'existe pas, et aucun projet n'a été rattaché.
    await expect(readFile(dehors, 'utf8')).rejects.toThrow();
    expect(await projetDuJob(jobId)).toBeNull();
  });
});
