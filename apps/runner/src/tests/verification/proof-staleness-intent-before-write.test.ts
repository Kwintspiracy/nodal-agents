// proof-staleness-intent-before-write.test.ts — LE TROU DE L'ISSUE #101,
// rejoué pas à pas sur un projet de code.
//
// LA SÉQUENCE, telle que l'issue la décrit (cinq pas) :
//
//   1. B pose son INTENTION et monte l'époque du projet
//      (`packages/tools/src/verification/intent.ts`) ;
//   2. B attend son checkpoint — l'ÉCRITURE vient après (`execute.ts`) ;
//   3. A capture l'époque montée par B, puis prouve l'ANCIEN contenu ;
//   4. B écrit un contenu invalide ;
//   5. A relit la même époque et le même manifeste : VERT PÉRIMÉ.
//
// Pourquoi la garde de `finalize.ts` ne voit rien. Elle compare l'époque et le
// manifeste d'avant et d'après la preuve. L'époque de B a été montée AVANT que
// A ne la capture, donc elle ne bouge plus ; et le manifeste d'un projet de
// code ne décrit QUE sa configuration de preuve (les commandes, le dossier,
// les versions de politique), jamais le contenu de l'arbre — il est identique
// des deux côtés d'une écriture. La génération sale de A, elle, ne bouge pas
// non plus : l'écriture n'est pas la sienne.
//
// Le vérificateur de DOCUMENTS a fermé sa moitié en #99 en rapportant ce que
// la preuve a réellement lu (`ProofResult.provedManifestHash`). Un projet de
// code n'a pas d'équivalent : sa preuve lance des commandes, et rien ne résume
// l'arbre sur lequel elles ont tourné.
//
// CE QUE CE FICHIER FAIT PASSER PAR LE VRAI SEAM. L'écriture de B traverse
// `executeTool` — intention, checkpoint, écriture, constat — parce que c'est
// là que vit la correction. Seule la PREUVE de A est remplacée par une
// fonction qui lit le fichier : elle rend le verdict du CONTENU, donc « vert
// sur l'ancien contenu » est un fait du disque, pas une valeur posée à la main.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import {
  agentJobs,
  codeProjects,
  jobDeliverableVerificationState,
  verificationRuns,
  and,
  eq,
} from '@nodal-agents/db';
import type { AnyDrizzleDb } from '@nodal-agents/db';
import {
  ENV_ALLOWLIST_VERSION,
  SHELL_POLICY_VERSION,
  hashVerificationManifest,
  normalizePath,
  projectKey,
} from '@nodal-agents/shared';
import type { VerifyCommand } from '@nodal-agents/shared';
import { executeTool } from '@nodal-agents/tools';
import type {
  ApprovalRule,
  ExecuteOptions,
  ToolContext,
  ToolDefinition,
} from '@nodal-agents/tools';
import { VERIFY_STALE_EPOCH, finalizeJobSuccess } from '../../job/finalize.ts';
import { codeProjectVerifier } from '../../verification/code-project.ts';
import type { DeliverableVerifier, ProofResult } from '../../verification/registry.ts';

let db: TestDb;
let seed: { userId: string; entityId: string; agentId: string; jobId: string };
let root: string;
let project: string;
let fichier: string;
let key: string;

/** Le contenu que la preuve accepte, et celui qu'elle refuse. */
const CONTENU_VALIDE = 'export const ok = 1;\n';
const CONTENU_INVALIDE = 'export const ok = // cassé\n';

const commands: VerifyCommand[] = [{ command: 'verifier', timeoutSeconds: 1 }];

type Log = { code: string; data: Record<string, unknown> }[];
const logger =
  (into: Log) =>
  (code: string, data: Record<string, unknown>): void => {
    into.push({ code, data });
  };

/** Attend qu'un drapeau se lève — jamais plus de `ms`. */
async function waitFor(flag: () => boolean, ms = 10_000): Promise<void> {
  const until = Date.now() + ms;
  while (!flag()) {
    if (Date.now() > until) throw new Error('WAIT_FOR_TIMEOUT');
    await new Promise((r) => setTimeout(r, 10));
  }
}

/**
 * L'outil qui écrit, sous le nom d'un outil mutant RÉEL.
 *
 * Le nom compte : `surfaceForTool` ne connaît que les outils de
 * `VERIFICATION_SURFACE_TOOLS`, et le seam refuse un outil mutant sans
 * surface. La sonde porte donc `file_write`, dans son propre registre — comme
 * le fait déjà `intent-wiring.test.ts` pour `run_command`.
 *
 * `attendre` est ce qui rend la séquence de l'issue jouable : l'intention est
 * déjà posée (le seam l'a écrite avant d'appeler `execute`), l'écriture ne
 * s'est pas encore produite, et c'est exactement le pas nº 2.
 */
function sonde(attendre: () => Promise<void>): ToolDefinition<z.ZodTypeAny, unknown> {
  return {
    name: 'file_write',
    description: 'sonde de test',
    inputSchema: z.object({ path: z.string(), content: z.string() }),
    riskLevel: 'write',
    mutatesWorkspace: true,
    resolveMutationTargets: async (input: { path: string }) => [
      {
        kind: 'file' as const,
        path: normalizePath(join(project, input.path)),
        deliverableType: 'code_project' as const,
        scope: 'addressed' as const,
      },
    ],
    execute: async (input: { path: string; content: string }) => {
      await attendre();
      await writeFile(join(project, input.path), input.content);
      return { written: input.path };
    },
  } as unknown as ToolDefinition<z.ZodTypeAny, unknown>;
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
    ] as ApprovalRule[],
    onApprovalRequired: async () => {},
  };
}

function ctx(jobId: string): ToolContext {
  return {
    db,
    entityId: seed.entityId,
    agentId: seed.agentId,
    jobId,
    jobChatId: null,
    workspaces: [{ label: 'projet', path: project }],
    turn: 1,
  } as unknown as ToolContext;
}

async function freshJob(task: string): Promise<string> {
  const [job] = await db
    .insert(agentJobs)
    .values({
      entityId: seed.entityId,
      agentId: seed.agentId,
      channel: 'api',
      task,
      status: 'processing',
    })
    .returning({ id: agentJobs.id });
  if (!job) throw new Error('job insert failed');
  return job.id;
}

/** L'écriture d'un job, du début à la fin, par le VRAI seam. */
async function ecrire(jobId: string, contenu: string): Promise<void> {
  const res = await executeTool(
    sonde(async () => {}),
    { path: 'index.ts', content: contenu },
    ctx(jobId),
    options(),
  );
  expect(res.outcome, 'la sonde s’est arrêtée avant le seam').toBe('success');
}

/**
 * Le vérificateur de projet de code RÉEL — sa `loadConfig`, donc son verrou,
 * son manifeste et son époque — dont la preuve LIT LE FICHIER au lieu de
 * lancer un shell. `apres` s'exécute une fois la lecture faite : c'est par lui
 * que la séquence s'interleave, la preuve restant suspendue pendant que
 * l'autre job écrit.
 */
function verificateur(hooks: { apres?: () => Promise<void> }): DeliverableVerifier {
  return {
    ...codeProjectVerifier,
    runProof: async (_config, onCommandDone): Promise<ProofResult> => {
      const lu = await readFile(fichier, 'utf8');
      const verdict = lu === CONTENU_VALIDE ? ('green' as const) : ('red' as const);
      const record = {
        rank: 0,
        command: 'verifier',
        outcomeKind: 'exit' as const,
        exitCode: verdict === 'green' ? 0 : 1,
        stdoutTail: '',
        stderrTail: '',
        durationMs: 1,
        verdict,
      };
      await onCommandDone(record);
      await hooks.apres?.();
      return { verdict, records: [record] };
    },
  };
}

async function etatDe(jobId: string) {
  const [row] = await db
    .select({
      decisionStatus: jobDeliverableVerificationState.decisionStatus,
      dirtyGeneration: jobDeliverableVerificationState.dirtyGeneration,
      verifiedGeneration: jobDeliverableVerificationState.verifiedGeneration,
      testedEpoch: jobDeliverableVerificationState.testedEpoch,
    })
    .from(jobDeliverableVerificationState)
    .where(
      and(
        eq(jobDeliverableVerificationState.jobId, jobId),
        eq(jobDeliverableVerificationState.canonicalKey, key),
      ),
    );
  return row;
}

async function epoque(): Promise<number> {
  const [row] = await db
    .select({ verificationEpoch: codeProjects.verificationEpoch })
    .from(codeProjects)
    .where(and(eq(codeProjects.entityId, seed.entityId), eq(codeProjects.projectKey, key)));
  return row?.verificationEpoch ?? -1;
}

beforeAll(async () => {
  const res = await spinUpTestDb();
  db = res.db;
  seed = await seedMinimal(db);
  root = await mkdtemp(join(tmpdir(), 'nodal-101-'));
});

afterAll(async () => {
  try {
    await rm(root, { recursive: true, force: true });
  } catch {
    /* jetable */
  }
});

beforeEach(async () => {
  // Un projet NEUF par cas : l'époque, la ligne `code_projects` et les états
  // lus ensuite ne peuvent venir que de CE cas.
  project = normalizePath(join(root, `p-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`));
  await mkdir(project, { recursive: true });
  // Un manifeste sur le disque : la racine EST le projet, et la clé de
  // l'intention comme celle de la finalisation tombent sur elle.
  await writeFile(join(project, 'package.json'), '{}');
  fichier = join(project, 'index.ts');
  await writeFile(fichier, CONTENU_VALIDE);
  key = projectKey(project);

  // La configuration de preuve, APPROUVÉE par le propriétaire : sans cela
  // `loadConfig` rend `pending_approval` et rien ne tourne.
  await db.insert(codeProjects).values({
    entityId: seed.entityId,
    projectPath: project,
    projectKey: key,
    verifyCommands: commands,
    verificationEpoch: 7,
    verifyApprovedManifestHash: hashVerificationManifest({
      verifierConfig: commands,
      invariants: [],
      canonicalKey: key,
      cwd: project,
      shellPolicyVersion: SHELL_POLICY_VERSION,
      envAllowlistVersion: ENV_ALLOWLIST_VERSION,
    }),
  });
});

describe('l’intention d’un autre job, posée AVANT la preuve (#101) @cap:verifier-un-livrable/moteur', () => {
  it('les cinq pas de l’issue : A ne finit PAS vert sur un contenu que B a remplacé pendant sa preuve', async () => {
    const jobA = await freshJob('A écrit puis prouve');
    const jobB = await freshJob('B écrit pendant la preuve de A');

    // A a écrit, comme n'importe quel job : son état est sale, et c'est ce
    // qu'il va chercher à prouver.
    await ecrire(jobA, CONTENU_VALIDE);

    // ── Pas 1 et 2 — B pose son intention, et s'arrête AVANT d'écrire ──────
    let bDansExecute = false;
    let libererB!: () => void;
    const barriereB = new Promise<void>((r) => {
      libererB = r;
    });
    const bRun = executeTool(
      sonde(async () => {
        bDansExecute = true;
        await barriereB;
      }),
      { path: 'index.ts', content: CONTENU_INVALIDE },
      ctx(jobB),
      options(),
    );
    await waitFor(() => bDansExecute);
    const epoqueApresIntentionDeB = await epoque();

    // ── Pas 3 — A capture cette époque, et prouve l'ANCIEN contenu ─────────
    let aAProuve = false;
    let libererA!: () => void;
    const barriereA = new Promise<void>((r) => {
      libererA = r;
    });
    const logs: Log = [];
    const aRun = finalizeJobSuccess(
      db as unknown as AnyDrizzleDb,
      { jobId: jobA, result: 'fini par A', resultKind: 'prose' },
      {
        getVerifier: () =>
          verificateur({
            apres: async () => {
              aAProuve = true;
              await barriereA;
            },
          }),
        log: logger(logs),
      },
    );
    await waitFor(() => aAProuve);

    // ── Pas 4 — B écrit son contenu invalide, maintenant ───────────────────
    libererB();
    const bRes = await bRun;
    expect(bRes.outcome).toBe('success');
    expect(await readFile(fichier, 'utf8')).toBe(CONTENU_INVALIDE);

    // ── Pas 5 — A referme. Ce qu'il a prouvé n'est plus sur le disque ──────
    libererA();
    const aOutcome = await aRun;

    // La preuve elle-même a bien été verte — sur un contenu qui n'existe plus.
    const runs = await db
      .select({ verdict: verificationRuns.verdict, testedEpoch: verificationRuns.testedEpoch })
      .from(verificationRuns)
      .where(eq(verificationRuns.jobId, jobA));
    expect(runs).toHaveLength(1);
    expect(runs[0]?.verdict).toBe('green');
    expect(runs[0]?.testedEpoch).toBe(epoqueApresIntentionDeB);

    // LE FOND. Un vert posé ici dit « ce projet est prouvé » d'un arbre que
    // personne n'a vérifié. L'état doit rester sale, et la finalisation doit
    // le DIRE (invariant #4).
    const etat = await etatDe(jobA);
    expect(
      etat?.decisionStatus,
      'A a posé un VERT PÉRIMÉ : sa preuve a lu l’ancien contenu, B a écrit ensuite',
    ).toBe('dirty');
    expect(etat?.verifiedGeneration).toBeNull();
    expect(logs.map((l) => l.code)).toContain(VERIFY_STALE_EPOCH);
    expect(aOutcome.observedDue).toBe(true);
    expect(aOutcome.kind).toBe('completed_unverified');
  }, 30_000);

  it('A seul : personne d’autre n’écrit, la preuve reste opposable et le job finit vert', async () => {
    const jobA = await freshJob('A seul');
    await ecrire(jobA, CONTENU_VALIDE);

    const logs: Log = [];
    const outcome = await finalizeJobSuccess(
      db as unknown as AnyDrizzleDb,
      { jobId: jobA, result: 'fini par A', resultKind: 'prose' },
      { getVerifier: () => verificateur({}), log: logger(logs) },
    );

    expect(outcome.kind).toBe('completed');
    expect(outcome.observedDue).toBe(false);
    expect(logs.map((l) => l.code)).not.toContain(VERIFY_STALE_EPOCH);
    const etat = await etatDe(jobA);
    expect(etat?.decisionStatus).toBe('green');
    expect(etat?.verifiedGeneration).toBe(etat?.dirtyGeneration);
  }, 30_000);

  it('A puis B EN SÉRIE : l’écriture de B est finie avant que A ne commence, A prouve l’arbre courant et finit vert', async () => {
    const jobA = await freshJob('A, après B');
    const jobB = await freshJob('B, avant A');

    await ecrire(jobA, CONTENU_INVALIDE);
    // B écrit ENTIÈREMENT — intention ET écriture — avant la preuve de A.
    await ecrire(jobB, CONTENU_VALIDE);

    const logs: Log = [];
    const outcome = await finalizeJobSuccess(
      db as unknown as AnyDrizzleDb,
      { jobId: jobA, result: 'fini par A', resultKind: 'prose' },
      { getVerifier: () => verificateur({}), log: logger(logs) },
    );

    // Rien ne bouge PENDANT la preuve : une écriture antérieure, même d'un
    // autre job, ne périme rien — c'est l'arbre que A vient de prouver.
    expect(outcome.kind).toBe('completed');
    expect(logs.map((l) => l.code)).not.toContain(VERIFY_STALE_EPOCH);
    expect((await etatDe(jobA))?.decisionStatus).toBe('green');
  }, 30_000);

  it('B seul : le job qui a écrit prouve son propre arbre et finit vert', async () => {
    const jobB = await freshJob('B seul');
    await ecrire(jobB, CONTENU_VALIDE);

    const logs: Log = [];
    const outcome = await finalizeJobSuccess(
      db as unknown as AnyDrizzleDb,
      { jobId: jobB, result: 'fini par B', resultKind: 'prose' },
      { getVerifier: () => verificateur({}), log: logger(logs) },
    );

    expect(outcome.kind).toBe('completed');
    expect((await etatDe(jobB))?.decisionStatus).toBe('green');
    expect(logs.map((l) => l.code)).not.toContain(VERIFY_STALE_EPOCH);
  }, 30_000);
});
