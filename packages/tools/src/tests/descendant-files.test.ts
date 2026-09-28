// descendant-files.test.ts — un fichier dont le CONTENU ACTUEL est ce qu'un de
// mes délégués a produit dans ce run est à moi : pour l'envoyer, et pour le
// déclarer comme livrable (#588, revue de #589).
//
// Le 29/09, Alfred ne pouvait ni envoyer l'image de ComfyArtist
// (`source_path_not_allowed` : elle vit dans le dossier du délégué) ni la
// déclarer (le run échouait alors que l'image existait). Mais le CHEMIN seul ne
// prouve rien (revue de #589) : un fichier supprimé puis recréé, remplacé au
// même chemin, ou la sortie d'un autre run déclarée par l'enfant, n'est pas ce
// que le délégué a produit. La preuve est celle que la plateforme emploie déjà
// (currentContentWrittenByJob, filesTheChildWrote) : l'empreinte, ou, pour une
// écriture que personne n'a pu empreindre, la date de modification dans la
// fenêtre du run du délégué.
//
// Vraie base, vrais fichiers. Le dossier du délégué est HORS de toute racine
// que la garde d'envoi autorise : `os.tmpdir()` est bouchonné sur une racine
// neuve, et le dossier du délégué en est un frère (voir outside-roots.ts).

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdir, writeFile, rm, realpath, utimes, symlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import {
  agentJobs,
  constatedWrites,
  entities,
  jobDeliverableVerificationState,
  eq,
} from '@nodal-agents/db';
import { normalizePath, projectKey } from '@nodal-agents/shared';
import {
  cleanupFakeTmpRoot,
  fakeTmpRootFor,
  makeOutsideDir,
} from '../communication/__tests__/outside-roots';

/** Le chemin dont la lecture est rendue ILLISIBLE (verrou, EACCES), à la demande. */
const etat = vi.hoisted(() => ({ illisible: null as string | null }));

// `fingerprint` rend `{ kind: 'unreadable' }` sans lever quand le fichier est là
// mais ne se lit pas (EBUSY, EACCES, verrou exclusif). Un verrou Windows ne se
// pose pas depuis un test portable : la lecture est simulée illisible pour un
// chemin, le reste est le vrai module.
vi.mock('../verification/observed', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../verification/observed')>();
  return {
    ...actual,
    fingerprint: async (p: string) =>
      etat.illisible !== null && p === etat.illisible
        ? { kind: 'unreadable' as const, size: null }
        : actual.fingerprint(p),
  };
});

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, tmpdir: () => fakeTmpRootFor('descendants') };
});

import { assertLocalSourceAllowed } from '../communication/delivery-guard';
import { declareDeliverables } from '../verification/declared-deliverables';
import { markStateDirty } from '../verification/intent';
import type { ToolContext } from '../types';

const MIN = 60_000;
const NOW = Date.now();

let db: TestDb;
let seed: { userId: string; entityId: string; agentId: string; jobId: string };
let rootJob: string;
let childJob: string;
let delegateWsRoot: string;
let otherEntity: string;
let ownWs: string;
const cleanup: string[] = [];

const sha = (content: string): string => createHash('sha256').update(content).digest('hex');

/** Un fichier réel, au contenu donné, modifié à `at` (ms). Rend son chemin réel. */
async function fichier(dir: string, name: string, content: string, at?: number): Promise<string> {
  await mkdir(dir, { recursive: true });
  const p = join(dir, name);
  await writeFile(p, content);
  if (at !== undefined) await utimes(p, new Date(at), new Date(at));
  return realpath(p);
}

async function job(opts: {
  parentJobId: string | null;
  createdAt: number;
  completedAt?: number;
  entityId?: string;
}): Promise<string> {
  const [row] = await db
    .insert(agentJobs)
    .values({
      entityId: opts.entityId ?? seed.entityId,
      agentId: seed.agentId,
      channel: 'api',
      task: 't',
      status: opts.completedAt === undefined ? 'processing' : 'completed',
      parentJobId: opts.parentJobId,
      createdAt: new Date(opts.createdAt),
      ...(opts.completedAt !== undefined ? { completedAt: new Date(opts.completedAt) } : {}),
    })
    .returning({ id: agentJobs.id });
  return row!.id;
}

/** Une écriture constatée : empreinte connue (outil de fichiers) ou `null` (shell). */
async function constat(jobId: string, path: string, contentSha256: string | null): Promise<void> {
  await db.insert(constatedWrites).values({
    jobId,
    turn: 1,
    path: normalizePath(path),
    changeKind: 'added',
    constatedBy: 'disk',
    contentSha256,
  });
}

/** Une déclaration posée par le geste réel (celui de return_result). */
async function declare(jobId: string, path: string): Promise<void> {
  await markStateDirty(db as never, jobId, {
    deliverableType: 'document',
    key: projectKey(normalizePath(path)),
    path: normalizePath(path),
    addressed: true,
    declared: true,
  });
}

function ctx(over: Partial<ToolContext> = {}): ToolContext {
  return {
    db,
    entityId: seed.entityId,
    agentId: seed.agentId,
    jobId: rootJob,
    jobChatId: null,
    workspaces: [{ label: 'own', path: ownWs }],
    turn: 1,
    ...over,
  } as unknown as ToolContext;
}

const panne = {
  select: () => {
    throw new Error('database unavailable');
  },
};

const f: Record<string, string> = {};

beforeAll(async () => {
  db = (await spinUpTestDb()).db;
  seed = await seedMinimal(db);
  await db.update(entities).set({ verificationSurfaces: {} }).where(eq(entities.id, seed.entityId));
  const [autre] = await db
    .insert(entities)
    .values({ name: 'Autre espace', slug: `autre-${Date.now()}`, userId: seed.userId })
    .returning();
  otherEntity = autre!.id;
  ownWs = await realpath(makeOutsideDir('own'));
  const delegateWs = await realpath(makeOutsideDir('delegate'));
  delegateWsRoot = delegateWs;
  const strangerWs = await realpath(makeOutsideDir('stranger'));
  const linkedWs = await realpath(makeOutsideDir('linked-target'));
  cleanup.push(ownWs, delegateWs, strangerWs, linkedWs);

  // La racine ; son délégué a tourné de -60 à -30 min, le sien de -50 à -40.
  rootJob = await job({ parentJobId: null, createdAt: NOW - 120 * MIN });
  const child = await job({
    parentJobId: rootJob,
    createdAt: NOW - 60 * MIN,
    completedAt: NOW - 30 * MIN,
  });
  childJob = child;
  const grandchild = await job({
    parentJobId: child,
    createdAt: NOW - 50 * MIN,
    completedAt: NOW - 40 * MIN,
  });
  const pendant = NOW - 45 * MIN;
  const out = join(delegateWs, 'outputs');

  // Ce que les délégués ont PRODUIT, et qui est resté tel quel.
  f.ecritParOutil = await fichier(out, 'tool.png', 'v1-tool', pendant);
  await constat(child, f.ecritParOutil, sha('v1-tool'));
  f.petitEnfant = await fichier(out, 'grandchild.png', 'v1-grand', pendant);
  await constat(grandchild, f.petitEnfant, sha('v1-grand'));
  f.ecritParShell = await fichier(out, 'shell.png', 'v1-shell', pendant);
  await constat(child, f.ecritParShell, null);
  f.declareComfy = await fichier(out, '9b964263_000.png', 'v1-comfy', pendant);
  await declare(child, f.declareComfy);

  // P1 : remplacé au même chemin après l'écriture du délégué.
  f.remplace = await fichier(out, 'replaced.png', 'v1-replaced', pendant);
  await constat(child, f.remplace, sha('v1-replaced'));
  await fichier(out, 'replaced.png', 'v2-by-someone-else');
  f.remplaceApresShell = await fichier(out, 'replaced-shell.png', 'v2-after-run');
  await constat(child, f.remplaceApresShell, null);

  // P2 : l'enfant déclare la sortie d'un AUTRE run, antérieure au sien.
  f.autreRunDeclare = await fichier(out, 'old-run.png', 'from-yesterday', NOW - 24 * 60 * MIN);
  await declare(child, f.autreRunDeclare);

  // Le contenu est provablement celui d'un autre job, hors de mes descendants.
  const etranger = await job({ parentJobId: null, createdAt: NOW - 55 * MIN });
  f.empreinteEtrangere = await fichier(out, 'claimed.png', 'someone-elses', pendant);
  await constat(child, f.empreinteEtrangere, null);
  await constat(etranger, f.empreinteEtrangere, sha('someone-elses'));

  // Un autre agent, un autre run, un autre espace.
  f.etranger = await fichier(strangerWs, 'secret.png', 'secret', pendant);
  const autreRacine = await job({ parentJobId: null, createdAt: NOW - 60 * MIN });
  const sonEnfant = await job({
    parentJobId: autreRacine,
    createdAt: NOW - 60 * MIN,
    completedAt: NOW - 30 * MIN,
  });
  f.autreRun = await fichier(out, 'other-run.png', 'other-run', pendant);
  await constat(sonEnfant, f.autreRun, sha('other-run'));
  const horsEspace = await job({
    parentJobId: rootJob,
    createdAt: NOW - 60 * MIN,
    completedAt: NOW - 30 * MIN,
    entityId: otherEntity,
  });
  f.horsEspace = await fichier(out, 'other-entity.png', 'other-entity', pendant);
  await constat(horsEspace, f.horsEspace, sha('other-entity'));

  // P2 : une racine attachée par jonction garde son chemin LEXICAL dans la
  // déclaration ; la garde cherche avec le RÉEL.
  const lien = join(delegateWs, 'via-jonction');
  await symlink(linkedWs, lien, process.platform === 'win32' ? 'junction' : 'dir');
  f.jonctionReel = await fichier(linkedWs, 'linked.png', 'linked', pendant);
  await declare(child, join(lien, 'linked.png'));
});

afterAll(async () => {
  for (const d of cleanup) await rm(d, { recursive: true, force: true }).catch(() => undefined);
  await cleanupFakeTmpRoot();
});

describe('a file my delegate produced is mine to deliver (#588) @cap:organiser-equipe/moteur', () => {
  it('accepted: fingerprinted and unchanged, by the child or the grandchild; unfingerprinted or declared, modified during the delegate’s run', async () => {
    for (const k of ['ecritParOutil', 'petitEnfant', 'ecritParShell', 'declareComfy']) {
      await expect(assertLocalSourceAllowed(f[k]!, ctx()), k).resolves.toBe(f[k]);
    }
  });

  it('a declared path through a junction matches the real path the guard looks up', async () => {
    await expect(assertLocalSourceAllowed(f.jonctionReel!, ctx())).resolves.toBe(f.jonctionReel);
  });

  it('refused: replaced since the delegate wrote it, another run’s output it declared, a content another job fingerprinted', async () => {
    for (const k of ['remplace', 'remplaceApresShell', 'autreRunDeclare', 'empreinteEtrangere']) {
      await expect(assertLocalSourceAllowed(f[k]!, ctx()), k).rejects.toThrow(
        /^source_path_not_allowed: local sources must be under/,
      );
    }
  });

  it('refused: another agent’s file, another run’s delegate’s file, a “child” in another entity', async () => {
    for (const k of ['etranger', 'autreRun', 'horsEspace']) {
      await expect(assertLocalSourceAllowed(f[k]!, ctx()), k).rejects.toThrow(
        /^source_path_not_allowed: local sources must be under/,
      );
    }
  });

  it('a file that exists but cannot be read (locked) is said unreadable, not “not yours”', async () => {
    etat.illisible = normalizePath(f.ecritParOutil!);
    try {
      await expect(assertLocalSourceAllowed(f.ecritParOutil!, ctx())).rejects.toThrow(
        /^descendant_files_unreadable: .*could not be read/,
      );
    } finally {
      etat.illisible = null;
    }
  });

  it('a failed read says it could not check, not that the file is not mine', async () => {
    await expect(
      assertLocalSourceAllowed(f.ecritParOutil!, ctx({ db: panne as never })),
    ).rejects.toThrow(/^descendant_files_unreadable: .*database unavailable/);
  });
});

describe('a file my delegate produced is mine to declare (#588) @cap:verifier-un-livrable/moteur', () => {
  it('declaring it writes a declared document row on MY job, keyed by its real path', async () => {
    const out = await declareDeliverables(ctx(), [f.declareComfy!]);

    expect(out.kind).toBe('written');
    if (out.kind !== 'written') return;
    expect(out.deliverables.map((d) => d.key)).toEqual([
      projectKey(normalizePath(f.declareComfy!)),
    ]);
    const rows = await db
      .select({
        key: jobDeliverableVerificationState.canonicalKey,
        declared: jobDeliverableVerificationState.declared,
      })
      .from(jobDeliverableVerificationState)
      .where(eq(jobDeliverableVerificationState.jobId, rootJob));
    expect(rows).toEqual([{ key: projectKey(normalizePath(f.declareComfy!)), declared: true }]);
  });

  it('declaring a replaced file or another run’s output stays unresolved, and nothing is written', async () => {
    const out = await declareDeliverables(ctx(), [
      f.ecritParOutil!,
      f.remplace!,
      f.autreRunDeclare!,
    ]);

    expect(out.kind).toBe('unresolved');
    if (out.kind !== 'unresolved') return;
    expect(out.unresolved.map((u) => u.requested)).toEqual([f.remplace, f.autreRunDeclare]);
  });

  it('a child cannot make a path outside its own folders declarable: it has no such descendant', async () => {
    const out = await declareDeliverables(
      ctx({ jobId: childJob, workspaces: [{ label: 'delegate', path: delegateWsRoot }] }),
      [f.etranger!],
    );

    expect(out.kind).toBe('unresolved');
    if (out.kind !== 'unresolved') return;
    expect(out.unresolved.map((u) => u.requested)).toEqual([f.etranger]);
  });

  it('a failed read is its own code, not a path the resolver refused', async () => {
    const out = await declareDeliverables(ctx({ db: panne as never }), [f.ecritParOutil!]);

    expect(out.kind).toBe('unresolved');
    if (out.kind !== 'unresolved') return;
    expect(out.unresolved[0]).toMatchObject({ code: 'descendant_files_unreadable' });
    expect(out.unresolved[0]?.reason).toContain('could not be checked');
  });
});
