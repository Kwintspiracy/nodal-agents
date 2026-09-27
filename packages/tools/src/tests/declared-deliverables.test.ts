// declared-deliverables.test.ts — les fichiers que l'agent DÉCLARE livrer
// deviennent-ils de vraies lignes d'état, prouvables par la finalisation ?
// (issue #509)
//
// Toutes les assertions portent sur des LIGNES relues en base : le type, la
// clé, le chemin, les drapeaux et la génération que la finalisation lira.

import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import { agentJobs, entities, jobDeliverableVerificationState, eq } from '@nodal-agents/db';
import { projectKey, normalizePath } from '@nodal-agents/shared';
import { executeTool } from '../execute';
import { fileWriteTool } from '../builtin/file-ops/file-write';
import { returnResultTool } from '../builtin/return-result';
import { declareDeliverables } from '../verification/declared-deliverables';
import { resolveAndCheckPath } from '../builtin/file-ops/workspace';
import type { ExecuteOptions, ToolContext } from '../types';

let db: TestDb;
let seed: { userId: string; entityId: string; agentId: string; jobId: string };
let root: string;
let ws: string;
let jobId: string;

beforeAll(async () => {
  db = (await spinUpTestDb()).db;
  seed = await seedMinimal(db);
});

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'nodal-declared-'));
  ws = join(root, 'ws');
  await mkdir(ws, { recursive: true });
  const [job] = await db
    .insert(agentJobs)
    .values({ entityId: seed.entityId, agentId: seed.agentId, channel: 'api', task: 'declared' })
    .returning();
  if (!job) throw new Error('job insert failed');
  jobId = job.id;
  await db.update(entities).set({ verificationSurfaces: {} }).where(eq(entities.id, seed.entityId));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true }).catch(() => undefined);
});

function ctx(over: Partial<ToolContext> = {}): ToolContext {
  return {
    db,
    entityId: seed.entityId,
    agentId: seed.agentId,
    jobId,
    jobChatId: null,
    workspaces: [{ label: 'work', path: ws }],
    turn: 1,
    ...over,
  } as unknown as ToolContext;
}

const opts: ExecuteOptions = { approvalRules: [], onApprovalRequired: async () => {} };

async function statesOf(job: string) {
  return db
    .select()
    .from(jobDeliverableVerificationState)
    .where(eq(jobDeliverableVerificationState.jobId, job));
}

const keyOf = (p: string): string => projectKey(normalizePath(p));

describe('return_result.deliverables — le schéma @cap:verifier-un-livrable/moteur', () => {
  it('accepte une liste de chemins et la rend telle quelle', () => {
    const parsed = returnResultTool.inputSchema.safeParse({
      status: 'success',
      deliverables: ['film.mp4', 'work/out/rapport.pdf'],
    });
    expect(parsed.success).toBe(true);
    if (parsed.success)
      expect(parsed.data.deliverables).toEqual(['film.mp4', 'work/out/rapport.pdf']);
  });

  it('reste optionnel — un succès sans fichier ne déclare rien', () => {
    const parsed = returnResultTool.inputSchema.safeParse({ status: 'success' });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.deliverables).toBeUndefined();
  });

  it('refuse un chemin vide', () => {
    expect(
      returnResultTool.inputSchema.safeParse({ status: 'success', deliverables: [''] }).success,
    ).toBe(false);
  });

  it('la description dit à TOUT agent de lister chaque fichier livré', () => {
    expect(returnResultTool.description).toMatch(/deliverables/);
    expect(returnResultTool.description).toMatch(/whatever tool or command produced it/);
  });
});

describe('declareDeliverables — une ligne d’état par fichier promis @cap:verifier-un-livrable/moteur', () => {
  it('un fichier qu’une commande devait produire devient un livrable DÉCLARÉ, sale, typé document', async () => {
    // Le fichier n'existe pas encore : la déclaration n'en présume rien, c'est
    // la preuve qui le constatera.
    const out = await declareDeliverables(ctx(), ['film.mp4']);
    expect(out.kind).toBe('written');

    const abs = await resolveAndCheckPath(ctx(), 'film.mp4');
    const rows = await statesOf(jobId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      deliverableType: 'document',
      canonicalKey: keyOf(abs),
      displayPathSnapshot: normalizePath(abs),
      decisionStatus: 'dirty',
      dirtyGeneration: 1,
      addressed: true,
      declared: true,
      produced: false,
    });
  });

  it('SOUS un projet de code, le fichier déclaré reste un FICHIER — la ligne du projet n’est pas celle qui le prouve', async () => {
    // La sortie par défaut de Remotion : `out/` DANS le projet.
    await mkdir(join(ws, 'remotion', 'out'), { recursive: true });
    await writeFile(join(ws, 'remotion', 'package.json'), '{"name":"film"}');
    const out = await declareDeliverables(ctx(), ['remotion/out/film.mp4']);
    expect(out.kind).toBe('written');
    const rows = await statesOf(jobId);
    expect(rows.map((r) => [r.deliverableType, r.canonicalKey, r.declared])).toEqual([
      ['document', keyOf(join(ws, 'remotion', 'out', 'film.mp4')), true],
    ]);
  });

  it('un fichier ÉCRIT par file_write puis déclaré retombe sur LA MÊME ligne', async () => {
    const written = await executeTool(
      fileWriteTool,
      { path: 'notes/rapport.md', content: '# Rapport\n', create_dirs: true },
      ctx(),
      opts,
    );
    expect(written.outcome).toBe('success');
    const avant = await statesOf(jobId);
    expect(avant).toHaveLength(1);
    expect(avant[0]).toMatchObject({ deliverableType: 'document', declared: false });

    await declareDeliverables(ctx(), ['notes/rapport.md']);
    const apres = await statesOf(jobId);
    expect(apres).toHaveLength(1);
    expect(apres[0]).toMatchObject({
      id: avant[0]!.id,
      declared: true,
      dirtyGeneration: 2,
      decisionStatus: 'dirty',
      // Ce que l'outil a constaté n'est pas effacé par la promesse.
      produced: avant[0]!.produced,
    });
  });

  it('un chemin irrésolu n’écrit RIEN, et rend la raison du résolveur des outils de fichiers', async () => {
    const dehors = join(root, 'ailleurs', 'film.mp4');
    const out = await declareDeliverables(ctx(), ['bon.mp4', dehors]);
    expect(out.kind).toBe('unresolved');
    if (out.kind === 'unresolved') {
      expect(out.unresolved.map((u) => u.requested)).toEqual([dehors]);
      expect(out.unresolved[0]?.reason).toMatch(/does not reside in any configured workspace/);
    }
    expect(await statesOf(jobId)).toHaveLength(0);
  });

  it('un agent SANS dossier ne peut rien déclarer — dit, pas ignoré', async () => {
    const out = await declareDeliverables(ctx({ workspaces: [] }), ['film.mp4']);
    expect(out.kind).toBe('unresolved');
    expect(await statesOf(jobId)).toHaveLength(0);
  });

  it('les cases de vérification de l’espace ne s’appliquent pas : une promesse n’est pas une écriture', async () => {
    await db
      .update(entities)
      .set({
        verificationSurfaces: { codeTask: false, cliRuntime: false, fileOps: false, shell: false },
      })
      .where(eq(entities.id, seed.entityId));
    const out = await declareDeliverables(ctx(), ['film.mp4']);
    expect(out.kind).toBe('written');
    expect((await statesOf(jobId)).map((r) => r.declared)).toEqual([true]);
  });

  it('un job déjà terminal ne reçoit plus rien', async () => {
    await db.update(agentJobs).set({ status: 'completed' }).where(eq(agentJobs.id, jobId));
    const out = await declareDeliverables(ctx(), ['film.mp4']);
    expect(out.kind).toBe('already_terminal');
    expect(await statesOf(jobId)).toHaveLength(0);
  });

  it('deux fois le même chemin fait UNE ligne', async () => {
    await declareDeliverables(ctx(), ['film.mp4', ' film.mp4 ']);
    expect(await statesOf(jobId)).toHaveLength(1);
  });
});
