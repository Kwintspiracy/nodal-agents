// write-epoch.test.ts — la SECONDE montée d'époque, celle de l'écriture
// (issue #101), prise deux fois : par le VRAI `executeTool`, puis sur la
// fonction seule pour les cas que le seam ne sait pas produire.
//
// L'ordre compte. Un test qui n'exerce que le helper laisse la suite verte
// quand le branchement disparaît — c'est arrivé quatre fois sur ce chantier
// (voir l'en-tête d'`intent.test.ts`). Le câblage vient donc d'abord, et les
// assertions sont des époques RELUES en base.

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import { agentJobs, codeProjects, and, eq } from '@nodal-agents/db';
import type { AnyDrizzleDb } from '@nodal-agents/db';
import { projectKey, normalizePath } from '@nodal-agents/shared';
import { executeTool } from '../execute';
import { fileWriteTool } from '../builtin/file-ops/file-write';
import { fileEditTool } from '../builtin/file-ops/file-edit';
import { bumpEpochsAfterWrite, WRITE_EPOCH_ROW_MISSING } from '../verification/write-epoch';
import type { DirtiedDeliverable } from '../verification/intent';
import type { ApprovalRule, ExecuteOptions, ToolContext } from '../types';

let db: TestDb;
let seed: { userId: string; entityId: string; agentId: string; jobId: string };
let root: string;
let ws: string;

const keyOf = (p: string): string => projectKey(normalizePath(p));

beforeAll(async () => {
  const res = await spinUpTestDb();
  db = res.db;
  seed = await seedMinimal(db);
});

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'nodal-write-epoch-'));
  ws = join(root, 'ws');
  await mkdir(ws, { recursive: true });
  // Un manifeste : la racine EST le projet, et la clé de l'intention tombe
  // sur elle plutôt que sur un sous-dossier.
  await writeFile(join(ws, 'package.json'), '{}');
  await db.delete(codeProjects);
});

afterEach(async () => {
  try {
    await rm(root, { recursive: true, force: true });
  } catch {
    /* jetable */
  }
});

async function newJob(): Promise<string> {
  const [job] = await db
    .insert(agentJobs)
    .values({
      entityId: seed.entityId,
      agentId: seed.agentId,
      channel: 'api',
      task: 'écrire',
      status: 'processing',
    })
    .returning({ id: agentJobs.id });
  if (!job) throw new Error('job insert failed');
  return job.id;
}

function ctx(jobId: string): ToolContext {
  return {
    db,
    entityId: seed.entityId,
    agentId: seed.agentId,
    jobId,
    jobChatId: null,
    workspaces: [{ label: 'ws', path: ws }],
    turn: 1,
  } as unknown as ToolContext;
}

function options(toolName = 'file_write'): ExecuteOptions {
  return {
    approvalRules: [
      {
        id: `rule-${toolName}`,
        toolName,
        action: 'auto_approve',
        agentId: seed.agentId,
        entityId: seed.entityId,
      },
    ] as ApprovalRule[],
    onApprovalRequired: async () => {},
  };
}

async function epochOf(key: string): Promise<number | null> {
  const [row] = await db
    .select({ verificationEpoch: codeProjects.verificationEpoch })
    .from(codeProjects)
    .where(and(eq(codeProjects.entityId, seed.entityId), eq(codeProjects.projectKey, key)));
  return row?.verificationEpoch ?? null;
}

const livrable = (key: string, epoch: number | null): DirtiedDeliverable => ({
  deliverableType: 'code_project',
  key,
  path: key,
  dirtyGeneration: 1,
  verificationEpoch: epoch,
  addressed: true,
});

describe('le seam monte l’époque APRÈS l’écriture @cap:verifier-un-livrable/moteur', () => {
  it('un file_write réussi laisse l’époque à 2 : une montée pour l’intention, une pour l’écriture', async () => {
    const jobId = await newJob();

    const res = await executeTool(
      fileWriteTool as never,
      { path: 'a.txt', content: 'bonjour' },
      ctx(jobId),
      options(),
    );

    expect(res.outcome).toBe('success');
    // Une seule montée laisserait 1, et une preuve concurrente partie entre
    // l'intention et l'écriture ne verrait rien bouger — le trou de #101.
    expect(await epochOf(keyOf(ws))).toBe(2);
  });

  it('une ÉDITION qui n’écrit rien (old_string absent) monte l’époque quand même — la tentative reste conservative', async () => {
    const jobId = await newJob();
    await writeFile(join(ws, 'a-editer.txt'), 'avant');

    await executeTool(
      fileEditTool as never,
      { path: 'a-editer.txt', old_string: 'texte-absent', new_string: 'apres' },
      ctx(jobId),
      options('file_edit'),
    );

    // L'édition n'a pas eu lieu — c'est le cas exact qui a coûté la
    // confusion `addressed` / `produced` (revue Codex PR #49, passe 2). Ce que
    // ce cas fixe : l'échec ne RAJEUNIT rien. L'intention avait sali le
    // projet, la sortie le fait vieillir pareil, et une preuve concurrente
    // partie entre les deux reste périmée.
    expect(await epochOf(keyOf(ws))).toBe(2);
  });

  it('deux écritures dans le même tour font QUATRE montées — chacune périme la preuve de la précédente', async () => {
    const jobId = await newJob();

    await executeTool(
      fileWriteTool as never,
      { path: 'a.txt', content: '1' },
      ctx(jobId),
      options(),
    );
    await executeTool(
      fileWriteTool as never,
      { path: 'b.txt', content: '2' },
      ctx(jobId),
      options(),
    );

    expect(await epochOf(keyOf(ws))).toBe(4);
  });
});

describe('bumpEpochsAfterWrite, la règle seule @cap:verifier-un-livrable/moteur', () => {
  it('ne monte QUE les livrables qui ont une ligne code_projects (epoch non nul)', async () => {
    const key = keyOf(ws);
    await db.insert(codeProjects).values({
      entityId: seed.entityId,
      projectPath: ws,
      projectKey: key,
      verificationEpoch: 5,
    });

    const montees = await bumpEpochsAfterWrite(db as unknown as AnyDrizzleDb, seed.entityId, [
      livrable(key, 5),
      // Un fichier bureautique n'a pas de ligne `code_projects` : son epoch
      // est `null`, et lui en créer une le ferait apparaître comme un projet
      // dans l'onglet Code.
      { ...livrable('c:/docs/rapport.docx', null), deliverableType: 'office_file' },
    ]);

    expect(montees).toBe(1);
    expect(await epochOf(key)).toBe(6);
    expect(await epochOf('c:/docs/rapport.docx')).toBeNull();
  });

  it('une clé vue deux fois ne monte l’époque qu’UNE fois', async () => {
    const key = keyOf(ws);
    await db.insert(codeProjects).values({
      entityId: seed.entityId,
      projectPath: ws,
      projectKey: key,
      verificationEpoch: 0,
    });

    const montees = await bumpEpochsAfterWrite(db as unknown as AnyDrizzleDb, seed.entityId, [
      livrable(key, 1),
      livrable(key, 1),
    ]);

    expect(montees).toBe(1);
    expect(await epochOf(key)).toBe(1);
  });

  it('la ligne a disparu entre l’intention et l’écriture : DIT par un code, jamais recréée', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const montees = await bumpEpochsAfterWrite(db as unknown as AnyDrizzleDb, seed.entityId, [
        livrable('c:/projets/disparu', 3),
      ]);
      expect(montees).toBe(0);
      const dits = warn.mock.calls.map((c) => c.map(String).join(' '));
      expect(dits.some((l) => l.includes(WRITE_EPOCH_ROW_MISSING))).toBe(true);
    } finally {
      warn.mockRestore();
    }
    // Recréer la ligne la remettrait à l'époque 1 et RAJEUNIRAIT le projet.
    expect(await epochOf('c:/projets/disparu')).toBeNull();
  });

  it('ne LÈVE jamais : une base en panne se dit par un code et rend 0', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const casse = {
      update: () => {
        throw new Error('base tombée');
      },
    } as unknown as AnyDrizzleDb;
    try {
      await expect(
        bumpEpochsAfterWrite(casse, seed.entityId, [livrable(keyOf(ws), 1)]),
      ).resolves.toBe(0);
      expect(error).toHaveBeenCalled();
    } finally {
      error.mockRestore();
    }
  });
});
