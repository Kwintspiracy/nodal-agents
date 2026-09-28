// descendant-files.test.ts — un fichier qu'un DÉLÉGUÉ a écrit est utilisable
// par le job qui l'a délégué : pour l'envoyer, et pour le déclarer comme
// livrable (#588).
//
// Le 29/09, Alfred ne pouvait ni envoyer l'image de ComfyArtist
// (`source_path_not_allowed` : elle vit dans le dossier du délégué) ni la
// déclarer (`DECLARED_DELIVERABLES_UNRESOLVED`, puis le run échouait alors que
// l'image existait et avait été envoyée). UNE règle d'accès : « les fichiers
// écrits par mes descendants dans ce run ». Elle n'élargit rien d'autre : le
// fichier d'un autre agent, qu'aucun de mes délégués n'a écrit, reste refusé.
//
// Vraie base, vrais fichiers. Le dossier du délégué est HORS de toute racine
// que la garde d'envoi autorise : `os.tmpdir()` est bouchonné sur une racine
// neuve, et le dossier du délégué en est un frère (voir outside-roots.ts).

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdir, writeFile, rm, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import {
  agentJobs,
  constatedWrites,
  jobDeliverableVerificationState,
  entities,
  eq,
} from '@nodal-agents/db';
import { normalizePath, projectKey } from '@nodal-agents/shared';
import {
  cleanupFakeTmpRoot,
  fakeTmpRootFor,
  makeOutsideDir,
} from '../communication/__tests__/outside-roots';

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, tmpdir: () => fakeTmpRootFor('descendants') };
});

import { assertLocalSourceAllowed } from '../communication/delivery-guard';
import { declareDeliverables } from '../verification/declared-deliverables';
import { markStateDirty } from '../verification/intent';
import type { ToolContext } from '../types';

let db: TestDb;
let seed: { userId: string; entityId: string; agentId: string; jobId: string };
let rootJob: string;
let ownWs: string;
let delegateWs: string;
let strangerWs: string;

/** Un fichier réel, écrit sur le disque, dont le chemin est rendu réel. */
async function fichier(dir: string, name: string): Promise<string> {
  await mkdir(dir, { recursive: true });
  const p = join(dir, name);
  await writeFile(p, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]));
  return realpath(p);
}

async function job(parentJobId: string | null): Promise<string> {
  const [row] = await db
    .insert(agentJobs)
    .values({
      entityId: seed.entityId,
      agentId: seed.agentId,
      channel: 'api',
      task: 't',
      status: parentJobId === null ? 'processing' : 'completed',
      parentJobId,
    })
    .returning({ id: agentJobs.id });
  return row!.id;
}

async function constat(jobId: string, path: string): Promise<void> {
  await db.insert(constatedWrites).values({
    jobId,
    turn: 1,
    path: path.replace(/\\/g, '/'),
    changeKind: 'added',
    constatedBy: 'disk',
  });
}

function ctx(): ToolContext {
  return {
    db,
    entityId: seed.entityId,
    agentId: seed.agentId,
    jobId: rootJob,
    jobChatId: null,
    workspaces: [{ label: 'own', path: ownWs }],
    turn: 1,
  } as unknown as ToolContext;
}

let childFile: string;
let grandchildFile: string;
let declaredFile: string;
let strangerFile: string;
let otherRootFile: string;

beforeAll(async () => {
  db = (await spinUpTestDb()).db;
  seed = await seedMinimal(db);
  await db.update(entities).set({ verificationSurfaces: {} }).where(eq(entities.id, seed.entityId));
  ownWs = await realpath(makeOutsideDir('own'));
  delegateWs = await realpath(makeOutsideDir('delegate'));
  strangerWs = await realpath(makeOutsideDir('stranger'));

  rootJob = await job(null);
  const child = await job(rootJob);
  const grandchild = await job(child);
  const otherRoot = await job(null);
  const otherChild = await job(otherRoot);

  // Ce que le délégué a écrit (un constat), ce que SON délégué a écrit, et ce
  // qu'il a déclaré comme livrable sans que la plateforme ne constate l'écriture
  // (une image que ComfyUI a posée lui-même).
  childFile = await fichier(join(delegateWs, 'outputs'), 'child.png');
  await constat(child, childFile);
  grandchildFile = await fichier(join(delegateWs, 'outputs'), 'grandchild.png');
  await constat(grandchild, grandchildFile);
  declaredFile = await fichier(join(delegateWs, 'outputs'), '9b964263_000.png');
  // Posée par le geste réel d'une déclaration (le même que return_result).
  await markStateDirty(db as never, child, {
    deliverableType: 'document',
    key: projectKey(normalizePath(declaredFile)),
    path: normalizePath(declaredFile),
    addressed: true,
    declared: true,
  });

  // Un fichier d'un AUTRE agent, qu'aucun de mes délégués n'a écrit : dans le
  // même dossier, puis dans un autre, et un que le délégué d'un AUTRE run a écrit.
  strangerFile = await fichier(strangerWs, 'secret.png');
  otherRootFile = await fichier(join(delegateWs, 'outputs'), 'other-run.png');
  await constat(otherChild, otherRootFile);
});

afterAll(async () => {
  for (const d of [ownWs, delegateWs, strangerWs]) {
    await rm(d, { recursive: true, force: true }).catch(() => undefined);
  }
  await cleanupFakeTmpRoot();
});

describe('a file my delegate wrote is mine to deliver (#588) @cap:organiser-equipe/moteur', () => {
  it('the delivery guard accepts the files my descendants wrote or declared, by absolute path', async () => {
    for (const f of [childFile, grandchildFile, declaredFile]) {
      await expect(assertLocalSourceAllowed(f, ctx()), f).resolves.toBe(f);
    }
  });

  it('it refuses another agent’s file, and a file another run’s delegate wrote', async () => {
    for (const f of [strangerFile, otherRootFile]) {
      await expect(assertLocalSourceAllowed(f, ctx()), f).rejects.toThrow(
        /^source_path_not_allowed: local sources must be under/,
      );
    }
  });
});

describe('a file my delegate wrote is mine to declare (#588) @cap:verifier-un-livrable/moteur', () => {
  it('declaring it writes a declared document row on MY job, keyed by its path', async () => {
    const out = await declareDeliverables(ctx(), [declaredFile]);

    expect(out.kind).toBe('written');
    if (out.kind !== 'written') return;
    expect(out.deliverables.map((d) => d.key)).toEqual([
      projectKey(declaredFile.replace(/\\/g, '/')),
    ]);
    const rows = await db
      .select({
        key: jobDeliverableVerificationState.canonicalKey,
        type: jobDeliverableVerificationState.deliverableType,
        declared: jobDeliverableVerificationState.declared,
      })
      .from(jobDeliverableVerificationState)
      .where(eq(jobDeliverableVerificationState.jobId, rootJob));
    expect(rows).toEqual([
      { key: projectKey(declaredFile.replace(/\\/g, '/')), type: 'document', declared: true },
    ]);
  });

  it('declaring another agent’s file stays unresolved, and nothing is written', async () => {
    const out = await declareDeliverables(ctx(), [childFile, strangerFile]);

    expect(out.kind).toBe('unresolved');
    if (out.kind !== 'unresolved') return;
    expect(out.unresolved.map((u) => u.requested)).toEqual([strangerFile]);
  });
});
