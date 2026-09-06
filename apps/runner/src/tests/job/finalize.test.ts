// finalize.test.ts — la primitive terminale typée.
//
// Ce que ces tests prouvent, sur de vraies lignes et de vrais processus :
//
//  - la GARDE N'EST PAS BRANCHÉE en PR① (v5-C) : un projet rouge finit quand
//    même `completed`, et la ligne `verification_runs` porte `red` ;
//  - la preuve tourne HORS transaction, et le garde de génération rattrape ce
//    que le verrou ne tient plus (`VERIFY_STALE_GENERATION`) — sans empêcher
//    le job de finir (correction T09(c)) ;
//  - `verification_runs` est BEST-EFFORT : table absente ⇒ code journalisé,
//    job terminal quand même ;
//  - deux finalisations concurrentes du même job : la seconde à commettre lit
//    `already_terminal` et n'écrase RIEN (le constat « incomplet » du verdict
//    de découpage, fermé ici en séquentiel ; l'interleaving réel est T14) ;
//  - la primitive ne connaît aucun type de livrable : un type sans
//    vérificateur lève, rien n'est écrit.

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { mkdtemp, rm, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import {
  and,
  asc,
  eq,
  sql,
  agentJobs,
  codeProjects,
  jobDeliveries,
  jobDeliverableVerificationState,
  verificationRuns,
} from '@nodal-agents/db';
import {
  ENV_ALLOWLIST_VERSION,
  SHELL_POLICY_VERSION,
  hashVerificationManifest,
  normalizePath,
  projectKey,
} from '@nodal-agents/shared';
import type { VerifyCommand } from '@nodal-agents/shared';
import {
  DELIVERY_PREPARE_UNAVAILABLE,
  FINALIZE_CLAIMED_ELSEWHERE,
  FINALIZING_STALE_MS,
  VERIFICATION_DUE_OBSERVED,
  VERIFY_PERSISTENCE_FAILED,
  VERIFY_STALE_EPOCH,
  VERIFY_STALE_GENERATION,
  VERIFY_TERMINAL_WRITE_LOST,
  finalizeJobSuccess,
} from '../../job/finalize.ts';
import type { FinalizeDeps } from '../../job/finalize.ts';
import type { DeliverableVerifier } from '../../verification/registry.ts';
import { MAX_TAIL_CHARS, codeProjectVerifier } from '../../verification/code-project.ts';

// Ces tests lancent de VRAIS processus (node) : sous la charge de la suite
// complète (une centaine de fichiers en parallèle), une preuve de 1 s en
// isolation en prend 8 — le défaut de 5 s rougissait un test correct.
vi.setConfig({ testTimeout: 30_000 });

let db: TestDb;
/**
 * Le moteur brut, pour le seul geste que Drizzle ne fait pas : renommer une
 * table le temps d'un test. Typé structurellement — le runner ne dépend pas
 * de `@electric-sql/pglite`, et ce test n'a pas à l'y faire entrer.
 */
let pg: { exec(sql: string): Promise<unknown> };
let seed: { userId: string; entityId: string; agentId: string; jobId: string };
let dir: string;
let projectPath: string;
let key: string;
const node = process.execPath;

/** Le cast que tous les tests du runner font : TestDb porte son schéma complet. */
const asDb = (): Parameters<typeof finalizeJobSuccess>[0] =>
  db as unknown as Parameters<typeof finalizeJobSuccess>[0];

/** Journal capturé — les codes, jamais des phrases (invariant #2). */
let logs: { code: string; data: Record<string, unknown> }[] = [];
const deps = (extra: FinalizeDeps = {}): FinalizeDeps => ({
  log: (code, data) => logs.push({ code, data }),
  ...extra,
});
const logged = (code: string): boolean => logs.some((l) => l.code === code);

beforeAll(async () => {
  const spun = await spinUpTestDb();
  db = spun.db;
  pg = spun.pg;
  seed = await seedMinimal(db);
  dir = await mkdtemp(join(tmpdir(), 'nodal-finalize-'));
  projectPath = normalizePath(dir);
  key = projectKey(projectPath);
});

afterAll(async () => {
  for (let i = 0; i < 5; i++) {
    try {
      await rm(dir, { recursive: true, force: true });
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 300));
    }
  }
});

beforeEach(async () => {
  logs = [];
  await db.delete(verificationRuns);
  await db.delete(jobDeliverableVerificationState);
  await db.delete(codeProjects);
});

async function script(name: string, body: string): Promise<string> {
  const p = join(dir, name);
  await writeFile(p, body, 'utf8');
  return `"${node}" "${p}"`;
}

const exists = async (p: string): Promise<boolean> => {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
};

const manifestHashOf = (commands: VerifyCommand[]): string =>
  hashVerificationManifest({
    verifierConfig: commands,
    invariants: [],
    canonicalKey: key,
    cwd: projectPath,
    shellPolicyVersion: SHELL_POLICY_VERSION,
    envAllowlistVersion: ENV_ALLOWLIST_VERSION,
  });

/** Pose la configuration de preuve du projet de test. */
async function setProject(
  commands: VerifyCommand[] | null,
  approved: 'current' | string | null,
): Promise<void> {
  const hash =
    approved === 'current' ? manifestHashOf(commands ?? []) : approved === null ? null : approved;
  await db.insert(codeProjects).values({
    entityId: seed.entityId,
    projectPath,
    projectKey: key,
    verifyCommands: commands,
    verificationEpoch: 7,
    verifyApprovedManifestHash: hash,
  });
}

async function insertJob(status: string, result = ''): Promise<string> {
  const [row] = await db
    .insert(agentJobs)
    .values({
      entityId: seed.entityId,
      agentId: seed.agentId,
      channel: 'api',
      task: 'finalize test',
      status,
      result,
    })
    .returning({ id: agentJobs.id });
  if (!row) throw new Error('job insert failed');
  return row.id;
}

async function insertState(
  jobId: string,
  deliverableType: string,
  canonicalKey: string,
  dirtyGeneration: number,
): Promise<string> {
  const [row] = await db
    .insert(jobDeliverableVerificationState)
    .values({
      jobId,
      deliverableType,
      canonicalKey,
      dirtyGeneration,
      decisionStatus: 'dirty',
    })
    .returning({ id: jobDeliverableVerificationState.id });
  if (!row) throw new Error('state insert failed');
  return row.id;
}

const jobRow = async (
  jobId: string,
): Promise<{ status: string | null; completedAt: Date | null; result: string | null }> => {
  const [row] = await db
    .select({
      status: agentJobs.status,
      completedAt: agentJobs.completedAt,
      result: agentJobs.result,
    })
    .from(agentJobs)
    .where(eq(agentJobs.id, jobId));
  if (!row) throw new Error('job not found');
  return row;
};

const stateRow = async (
  stateId: string,
): Promise<{
  decisionStatus: string;
  verifiedGeneration: number | null;
  dirtyGeneration: number | null;
  testedEpoch: number | null;
  commandHashSnapshot: string | null;
}> => {
  const [row] = await db
    .select({
      decisionStatus: jobDeliverableVerificationState.decisionStatus,
      verifiedGeneration: jobDeliverableVerificationState.verifiedGeneration,
      dirtyGeneration: jobDeliverableVerificationState.dirtyGeneration,
      testedEpoch: jobDeliverableVerificationState.testedEpoch,
      commandHashSnapshot: jobDeliverableVerificationState.commandHashSnapshot,
    })
    .from(jobDeliverableVerificationState)
    .where(eq(jobDeliverableVerificationState.id, stateId));
  if (!row) throw new Error('state not found');
  return row;
};

const runsOf = async (
  jobId: string,
): Promise<
  {
    commandRank: number;
    verdict: string;
    exitCode: number | null;
    outcomeKind: string;
    testedGeneration: number | null;
    testedEpoch: number | null;
    stdoutTail: string | null;
    manifestHash: string | null;
    sequenceId: string;
  }[]
> =>
  db
    .select({
      commandRank: verificationRuns.commandRank,
      verdict: verificationRuns.verdict,
      exitCode: verificationRuns.exitCode,
      outcomeKind: verificationRuns.outcomeKind,
      testedGeneration: verificationRuns.testedGeneration,
      testedEpoch: verificationRuns.testedEpoch,
      stdoutTail: verificationRuns.stdoutTail,
      manifestHash: verificationRuns.manifestHash,
      sequenceId: verificationRuns.sequenceId,
    })
    .from(verificationRuns)
    .where(eq(verificationRuns.jobId, jobId))
    .orderBy(asc(verificationRuns.commandRank));

// ─── v5-C : la garde n'est PAS branchée ─────────────────────────────────────

describe('finalizeJobSuccess — phase d’observation (v5-C)', () => {
  it('projet ROUGE : le job finit quand même completed, et verification_runs porte red', async () => {
    const red = await script('red.js', "process.stderr.write('boum'); process.exit(1)");
    const commands = [{ command: red, timeoutSeconds: 20 }];
    await setProject(commands, 'current');
    const jobId = await insertJob('processing');
    const stateId = await insertState(jobId, 'code_project', key, 1);

    const outcome = await finalizeJobSuccess(
      asDb(),
      { jobId: jobId, result: 'fini', toolsUsed: ['return_result'] },
      deps(),
    );

    // La garde n'est pas branchée : le job finit.
    expect(outcome.kind).toBe('completed_unverified');
    expect(outcome.observedOutcome).toBe('verification_due');
    expect(outcome.observedDue).toBe(true);
    expect(logged(VERIFICATION_DUE_OBSERVED)).toBe(true);

    const job = await jobRow(jobId);
    expect(job.status).toBe('completed');
    expect(job.completedAt).toBeTruthy();
    expect(job.result).toBe('fini');

    const runs = await runsOf(jobId);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.verdict).toBe('red');
    expect(runs[0]?.exitCode).toBe(1);
    expect(runs[0]?.commandRank).toBe(0);
    expect(runs[0]?.outcomeKind).toBe('exit');
    expect(runs[0]?.testedGeneration).toBe(1);
    expect(runs[0]?.testedEpoch).toBe(7);
    expect(runs[0]?.manifestHash).toBe(manifestHashOf(commands));

    const state = await stateRow(stateId);
    expect(state.decisionStatus).toBe('red');
    expect(state.verifiedGeneration).toBeNull();
  });

  it('projet VERT ⇒ completed, état green, verified_generation = dirty_generation', async () => {
    const green = await script('green.js', 'process.exit(0)');
    const commands = [{ command: green, timeoutSeconds: 20 }];
    await setProject(commands, 'current');
    const jobId = await insertJob('processing');
    const stateId = await insertState(jobId, 'code_project', key, 3);

    const outcome = await finalizeJobSuccess(
      asDb(),
      { jobId: jobId, result: 'ok', toolsUsed: [] },
      deps(),
    );

    expect(outcome.kind).toBe('completed');
    expect(outcome.observedOutcome).toBe('completed');
    expect(outcome.observedDue).toBe(false);
    expect(outcome.decisions).toEqual([
      {
        deliverableType: 'code_project',
        canonicalKey: key,
        decisionStatus: 'green',
        settled: true,
        unverifiable: false,
        due: false,
      },
    ]);

    expect((await jobRow(jobId)).status).toBe('completed');
    const state = await stateRow(stateId);
    expect(state.decisionStatus).toBe('green');
    expect(state.verifiedGeneration).toBe(3);
    expect(state.dirtyGeneration).toBe(3);
    expect(state.testedEpoch).toBe(7);
    expect(state.commandHashSnapshot).toBe(manifestHashOf(commands));
  });

  it('séquence [ok, exit 1] ⇒ deux lignes rangs 0 et 1, verdict red, état red, même sequence_id', async () => {
    const ok = await script('seq-ok.js', "process.stdout.write('a')");
    const red = await script('seq-red.js', 'process.exit(1)');
    await setProject(
      [
        { command: ok, timeoutSeconds: 20 },
        { command: red, timeoutSeconds: 20 },
      ],
      'current',
    );
    const jobId = await insertJob('processing');
    const stateId = await insertState(jobId, 'code_project', key, 1);

    await finalizeJobSuccess(asDb(), { jobId: jobId, result: 'ok', toolsUsed: [] }, deps());

    const runs = await runsOf(jobId);
    expect(runs.map((r) => r.commandRank)).toEqual([0, 1]);
    expect(runs.map((r) => r.verdict)).toEqual(['green', 'red']);
    expect(runs[0]?.sequenceId).toBe(runs[1]?.sequenceId);
    expect((await stateRow(stateId)).decisionStatus).toBe('red');
    expect((await jobRow(jobId)).status).toBe('completed');
  });
});

// ─── Livrables non prouvables ───────────────────────────────────────────────

describe('finalizeJobSuccess — non configuré et non approuvé', () => {
  it('un livrable office_file finalise sans lever, et n’emprunte PAS les commandes du projet', async () => {
    // v7-A. Avant, tout était rangé en `code_project` : un classeur écrit dans
    // un dépôt déclenchait la séquence de preuve DU DÉPÔT. Deux choses à
    // prouver ici : (1) le type traverse la primitive sans lever
    // `DELIVERABLE_TYPE_UNSUPPORTED`, (2) aucune commande du projet ne tourne
    // pour lui — constaté par un fichier témoin que la commande écrirait.
    const witness = join(dir, 'temoin-office.txt');
    const cmd = await script(
      'office.js',
      `require('node:fs').writeFileSync(${JSON.stringify(witness)}, 'x')`,
    );
    await setProject([{ command: cmd, timeoutSeconds: 20 }], 'current');

    const jobId = await insertJob('processing');
    const stateId = await insertState(jobId, 'office_file', `${key}/rapport.xlsx`, 1);

    const outcome = await finalizeJobSuccess(
      asDb(),
      { jobId: jobId, result: 'classeur écrit', toolsUsed: ['xlsx_create'] },
      deps(),
    );

    expect(await exists(witness)).toBe(false);
    expect(await runsOf(jobId)).toHaveLength(0);
    expect(outcome.kind).toBe('completed_unverified');
    expect(outcome.decisions).toEqual([
      {
        deliverableType: 'office_file',
        canonicalKey: `${key}/rapport.xlsx`,
        decisionStatus: 'not_configured',
        settled: false,
        unverifiable: true,
        due: false,
      },
    ]);
    expect((await stateRow(stateId)).decisionStatus).toBe('not_configured');
    expect((await jobRow(jobId)).status).toBe('completed');
  });

  it('verify_commands NULL ⇒ aucune ligne verification_runs, état not_configured, completed_unverified', async () => {
    await setProject(null, null);
    const jobId = await insertJob('processing');
    const stateId = await insertState(jobId, 'code_project', key, 1);

    const outcome = await finalizeJobSuccess(
      asDb(),
      { jobId: jobId, result: 'ok', toolsUsed: [] },
      deps(),
    );

    expect(outcome.kind).toBe('completed_unverified');
    expect(outcome.observedOutcome).toBe('completed_unverified');
    expect(outcome.observedDue).toBe(false);
    expect(await runsOf(jobId)).toHaveLength(0);
    expect((await stateRow(stateId)).decisionStatus).toBe('not_configured');
    expect((await jobRow(jobId)).status).toBe('completed');
  });

  it('hash approuvé ≠ hash courant ⇒ état pending_approval et AUCUNE commande lancée', async () => {
    const witness = join(dir, 'temoin-approval.txt');
    const cmd = await script(
      'approval.js',
      `require('node:fs').writeFileSync(${JSON.stringify(witness)}, 'x')`,
    );
    await setProject(
      [{ command: cmd, timeoutSeconds: 6 }],
      manifestHashOf([{ command: cmd, timeoutSeconds: 5 }]),
    );
    const jobId = await insertJob('processing');
    const stateId = await insertState(jobId, 'code_project', key, 1);

    const outcome = await finalizeJobSuccess(
      asDb(),
      { jobId: jobId, result: 'ok', toolsUsed: [] },
      deps(),
    );

    expect(await exists(witness)).toBe(false);
    expect(await runsOf(jobId)).toHaveLength(0);
    expect((await stateRow(stateId)).decisionStatus).toBe('pending_approval');
    expect(outcome.observedDue).toBe(true);
    expect((await jobRow(jobId)).status).toBe('completed');
  });

  it('aucun livrable du tout ⇒ completed sec, zéro ligne écrite', async () => {
    const jobId = await insertJob('processing');
    const outcome = await finalizeJobSuccess(
      asDb(),
      { jobId: jobId, result: 'sans livrable', toolsUsed: [] },
      deps(),
    );
    expect(outcome.kind).toBe('completed');
    expect(outcome.decisions).toEqual([]);
    expect(await runsOf(jobId)).toHaveLength(0);
    expect((await jobRow(jobId)).status).toBe('completed');
  });
});

// ─── Course terminale ───────────────────────────────────────────────────────

describe('finalizeJobSuccess — déjà terminal', () => {
  it('job déjà failed ⇒ already_terminal, aucun UPDATE, aucune ligne de run', async () => {
    const green = await script('green2.js', 'process.exit(0)');
    await setProject([{ command: green, timeoutSeconds: 20 }], 'current');
    const jobId = await insertJob('failed');
    const stateId = await insertState(jobId, 'code_project', key, 1);

    const outcome = await finalizeJobSuccess(
      asDb(),
      { jobId: jobId, result: 'trop tard', toolsUsed: [] },
      deps(),
    );

    expect(outcome.kind).toBe('already_terminal');
    expect(outcome.observedOutcome).toBe('already_terminal');
    expect(outcome.decisions).toEqual([]);
    const job = await jobRow(jobId);
    expect(job.status).toBe('failed');
    expect(job.result).toBe('');
    expect(job.completedAt).toBeNull();
    expect(await runsOf(jobId)).toHaveLength(0);
    expect((await stateRow(stateId)).decisionStatus).toBe('dirty');
  });

  it('deux finalisations successives ⇒ la seconde rend already_terminal', async () => {
    await setProject(null, null);
    const jobId = await insertJob('processing');
    await insertState(jobId, 'code_project', key, 1);

    const first = await finalizeJobSuccess(
      asDb(),
      { jobId: jobId, result: 'premier', toolsUsed: [] },
      deps(),
    );
    const second = await finalizeJobSuccess(
      asDb(),
      { jobId: jobId, result: 'second', toolsUsed: [] },
      deps(),
    );

    expect(first.kind).toBe('completed_unverified');
    expect(second.kind).toBe('already_terminal');
    expect((await jobRow(jobId)).result).toBe('premier');
  });

  it(
    'second finaliseur concurrent : il se retire AVANT toute preuve (réclamation en transaction 1), le premier finit seul',
    { timeout: 15_000 },
    async () => {
      // Interleaving à la frontière tx1 / tx2, joué en séquentiel : le
      // finaliseur A passe sa transaction 1 (job non terminal, marqueur posé),
      // puis PENDANT sa preuve — hors transaction — le finaliseur B se présente.
      // B lit le marqueur frais de A et se retire (FINALIZE_CLAIMED_ELSEWHERE)
      // sans lancer de preuve : une seule séquence verification_runs par job.
      // Le vrai interleaving à deux connexions est T14.
      //
      // Le TIMEOUT est une assertion : B passe sa transaction 1 à travers `db`
      // pendant que A est entre ses deux transactions. Si la preuve de A
      // tournait SOUS une transaction (mutation T19), la connexion unique de
      // PGlite serait tenue et B attendrait pour toujours — ce test rougit
      // alors par timeout au lieu de pendre la suite (revue T09).
      await setProject(null, null);
      const jobId = await insertJob('processing');
      const stateId = await insertState(jobId, 'code_project', key, 1);
      let bOutcome: string | null = null;

      const verifierA: DeliverableVerifier = {
        deliverableType: 'code_project',
        canonicalize: projectKey,
        loadConfig: async () => ({
          kind: 'ready',
          manifestHash: 'v1:stub',
          cwd: projectPath,
          commands: [{ command: 'stub', timeoutSeconds: 1 }],
          epoch: 7,
        }),
        runProof: async (_config, onCommandDone) => {
          const record = {
            rank: 0,
            command: 'stub',
            outcomeKind: 'exit' as const,
            exitCode: 0,
            stdoutTail: '',
            stderrTail: '',
            durationMs: 1,
            verdict: 'green' as const,
          };
          await onCommandDone(record);
          // B se présente pendant que A est hors transaction.
          bOutcome = (
            await finalizeJobSuccess(
              asDb(),
              { jobId: jobId, result: 'par B', toolsUsed: [] },
              deps(),
            )
          ).kind;
          return { verdict: 'green', records: [record] };
        },
      };

      const a = await finalizeJobSuccess(
        asDb(),
        { jobId, result: 'par A' },
        deps({ getVerifier: () => verifierA }),
      );

      expect(bOutcome).toBe('already_terminal');
      expect(logged(FINALIZE_CLAIMED_ELSEWHERE)).toBe(true);
      expect(a.kind).toBe('completed');
      expect(logged(VERIFY_TERMINAL_WRITE_LOST)).toBe(false);
      // A a fini seul : l'état porte SA décision (green), le résultat est le sien,
      // et la preuve n'a tourné qu'une fois.
      expect((await stateRow(stateId)).decisionStatus).toBe('green');
      expect((await jobRow(jobId)).result).toBe('par A');
      expect(await runsOf(jobId)).toHaveLength(1);
    },
  );
});

// ─── Le garde de génération et la persistance ───────────────────────────────

describe('finalizeJobSuccess — génération périmée et persistance', () => {
  it('une écriture pendant la preuve ⇒ VERIFY_STALE_GENERATION journalisé, état laissé sale, job terminé', async () => {
    await setProject(null, null);
    const jobId = await insertJob('processing');
    const stateId = await insertState(jobId, 'code_project', key, 1);

    const bumping: DeliverableVerifier = {
      deliverableType: 'code_project',
      canonicalize: projectKey,
      loadConfig: async () => ({
        kind: 'ready',
        manifestHash: 'v1:stub',
        cwd: projectPath,
        commands: [{ command: 'stub', timeoutSeconds: 1 }],
        epoch: 7,
      }),
      runProof: async (_config, onCommandDone) => {
        const record = {
          rank: 0,
          command: 'stub',
          outcomeKind: 'exit' as const,
          exitCode: 0,
          stdoutTail: '',
          stderrTail: '',
          durationMs: 1,
          verdict: 'green' as const,
        };
        await onCommandDone(record);
        // L'agent écrit encore : la génération avance pendant la preuve.
        await db
          .update(jobDeliverableVerificationState)
          .set({ dirtyGeneration: 2 })
          .where(eq(jobDeliverableVerificationState.id, stateId));
        return { verdict: 'green', records: [record] };
      },
    };

    const outcome = await finalizeJobSuccess(
      asDb(),
      { jobId, result: 'ok' },
      deps({ getVerifier: () => bumping }),
    );

    expect(logged(VERIFY_STALE_GENERATION)).toBe(true);
    expect(outcome.observedOutcome).toBe('verification_due');
    expect(outcome.observedDue).toBe(true);
    const state = await stateRow(stateId);
    // La preuve portait sur la génération 1, la ligne est en 2 : rien n'est
    // validé, l'état reste sale.
    expect(state.decisionStatus).toBe('dirty');
    expect(state.verifiedGeneration).toBeNull();
    expect(state.dirtyGeneration).toBe(2);
    // …et le job finit quand même (correction T09(c), v5-C).
    expect((await jobRow(jobId)).status).toBe('completed');
    // La ligne de run, elle, a bien été écrite avec la génération testée.
    const runs = await runsOf(jobId);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.testedGeneration).toBe(1);
  });

  it('table verification_runs absente ⇒ VERIFY_PERSISTENCE_FAILED journalisé, job terminé quand même (best-effort)', async () => {
    const green = await script('green3.js', 'process.exit(0)');
    await setProject([{ command: green, timeoutSeconds: 20 }], 'current');
    const jobId = await insertJob('processing');
    const stateId = await insertState(jobId, 'code_project', key, 1);

    await pg.exec('ALTER TABLE verification_runs RENAME TO verification_runs_absente;');
    let outcome;
    try {
      outcome = await finalizeJobSuccess(
        asDb(),
        { jobId: jobId, result: 'ok', toolsUsed: [] },
        deps(),
      );
    } finally {
      await pg.exec('ALTER TABLE verification_runs_absente RENAME TO verification_runs;');
    }

    expect(logged(VERIFY_PERSISTENCE_FAILED)).toBe(true);
    expect(outcome.observedOutcome).toBe('verification_persistence_failed');
    // La décision d'état, elle, a bien été écrite : seule la trace a manqué.
    expect((await stateRow(stateId)).decisionStatus).toBe('green');
    expect((await jobRow(jobId)).status).toBe('completed');
  });

  it('queues bornées : une commande qui écrit 10 Mo ⇒ stdout_tail ≤ 16 Ko et garde la DERNIÈRE ligne', async () => {
    const noisy = await script(
      'noisy.js',
      [
        "const chunk = 'x'.repeat(10000);",
        'for (let i = 0; i < 1000; i++) process.stdout.write(chunk);',
        "process.stdout.write('\\nDERNIERE-LIGNE');",
      ].join('\n'),
    );
    await setProject([{ command: noisy, timeoutSeconds: 60 }], 'current');
    const jobId = await insertJob('processing');
    await insertState(jobId, 'code_project', key, 1);

    await finalizeJobSuccess(asDb(), { jobId: jobId, result: 'ok', toolsUsed: [] }, deps());

    const runs = await runsOf(jobId);
    expect(runs).toHaveLength(1);
    const tail = runs[0]?.stdoutTail ?? '';
    expect(tail.length).toBeLessThanOrEqual(MAX_TAIL_CHARS);
    expect(tail.endsWith('DERNIERE-LIGNE')).toBe(true);
  });
});

// ─── Aucun type de livrable dans la primitive ───────────────────────────────

describe('finalizeJobSuccess — le registre décide, pas la primitive', () => {
  it('un livrable d’un type sans vérificateur ⇒ DELIVERABLE_TYPE_UNSUPPORTED, rien n’est écrit', async () => {
    const jobId = await insertJob('processing');
    // `document` reste réservé sans vérificateur (v7-A en branche deux :
    // `code_project` et `office_file`). Le jour où il en gagne un, ce test
    // doit être reporté sur un type encore réservé — pas supprimé.
    const stateId = await insertState(jobId, 'document', '/srv/rapport.docx', 1);

    await expect(
      finalizeJobSuccess(asDb(), { jobId: jobId, result: 'ok', toolsUsed: [] }, deps()),
    ).rejects.toThrow('DELIVERABLE_TYPE_UNSUPPORTED');

    const job = await jobRow(jobId);
    expect(job.status).toBe('processing');
    expect(job.completedAt).toBeNull();
    expect(await runsOf(jobId)).toHaveLength(0);
    expect((await stateRow(stateId)).decisionStatus).toBe('dirty');
  });
});

// ─── Résultat et point d'extension de livraison ─────────────────────────────

describe('finalizeJobSuccess — résultat compilé et livraison', () => {
  it('result vide + enfants avec résultats ⇒ le result compilé est écrit dans la transaction', async () => {
    const parentId = await insertJob('processing');
    for (const texte of ['premier enfant', 'second enfant']) {
      await db.insert(agentJobs).values({
        entityId: seed.entityId,
        agentId: seed.agentId,
        channel: 'api',
        task: 'enfant',
        status: 'completed',
        result: texte,
        parentJobId: parentId,
      });
    }

    await finalizeJobSuccess(asDb(), { jobId: parentId, result: '', toolsUsed: [] }, deps());

    const job = await jobRow(parentId);
    expect(job.status).toBe('completed');
    expect(job.result).toContain('premier enfant');
    expect(job.result).toContain('second enfant');
  });

  it('une livraison demandée sans préparateur (T08 absent) ⇒ refus fort, rien n’est écrit', async () => {
    const jobId = await insertJob('processing');
    await expect(
      finalizeJobSuccess(
        asDb(),
        { jobId, result: 'ok', delivery: { channel: 'telegram', chatId: '42', payload: 'ok' } },
        deps(),
      ),
    ).rejects.toThrow(DELIVERY_PREPARE_UNAVAILABLE);
    expect((await jobRow(jobId)).status).toBe('processing');
  });

  it('le préparateur fourni écrit DANS la transaction terminale : son échec annule le statut', async () => {
    const jobId = await insertJob('processing');
    await expect(
      finalizeJobSuccess(
        asDb(),
        { jobId, result: 'ok', delivery: { channel: 'telegram', chatId: '42', payload: 'ok' } },
        deps({
          prepareDelivery: async () => {
            throw new Error('canal indisponible');
          },
        }),
      ),
    ).rejects.toThrow('canal indisponible');
    const job = await jobRow(jobId);
    expect(job.status).toBe('processing');
    expect(job.completedAt).toBeNull();
  });

  it('le préparateur fourni est commis AVEC le statut terminal', async () => {
    const jobId = await insertJob('processing');
    const outcome = await finalizeJobSuccess(
      asDb(),
      { jobId, result: 'ok', delivery: { channel: 'telegram', chatId: '42', payload: 'à livrer' } },
      deps({
        prepareDelivery: async (tx, input) => {
          await tx.insert(jobDeliveries).values({
            jobId: input.jobId,
            channel: input.channel,
            chatId: input.chatId,
            payload: input.payload,
            outcome: 'prepared',
            idempotencyKey: `${input.jobId}:${input.channel}:${input.chatId}:0`,
          });
        },
      }),
    );

    expect(outcome.kind).toBe('completed');
    const rows = await db
      .select({ outcome: jobDeliveries.outcome, payload: jobDeliveries.payload })
      .from(jobDeliveries)
      .where(and(eq(jobDeliveries.jobId, jobId), eq(jobDeliveries.channel, 'telegram')));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.outcome).toBe('prepared');
    expect((await jobRow(jobId)).status).toBe('completed');
  });
});

// ─── La réclamation du marqueur finalizing_at — UNE preuve par job ──────────
//
// La preuve tourne hors transaction (décision n°5), donc le FOR UPDATE de la
// transaction 1 ne sérialise plus deux finalisations du même job : sans
// marqueur, chacune lancerait SA preuve et la seconde ne l'apprendrait qu'en
// transaction 2 (le verdict « incomplet » du découpage). Le marqueur est posé
// sous le verrou de la transaction 1 ; un marqueur frais posé par un autre
// finaliseur retire le nôtre AVANT toute preuve.

describe('la réclamation du marqueur finalizing_at', () => {
  const stubVerifier = (onProof: () => void): DeliverableVerifier => ({
    deliverableType: 'code_project',
    canonicalize: projectKey,
    loadConfig: async () => ({
      kind: 'ready',
      manifestHash: 'v1:stub',
      cwd: projectPath,
      commands: [{ command: 'stub', timeoutSeconds: 1 }],
      epoch: 1,
    }),
    runProof: async () => {
      onProof();
      return { verdict: 'green', records: [] };
    },
  });

  it('marqueur FRAIS posé par un autre finaliseur ⇒ already_terminal, FINALIZE_CLAIMED_ELSEWHERE, AUCUNE preuve, rien d’écrit', async () => {
    const jobId = await insertJob('processing');
    const stateId = await insertState(jobId, 'code_project', key, 1);
    await db.update(agentJobs).set({ finalizingAt: new Date() }).where(eq(agentJobs.id, jobId));
    let proofs = 0;

    const outcome = await finalizeJobSuccess(
      asDb(),
      { jobId, result: 'par le second' },
      deps({ getVerifier: () => stubVerifier(() => proofs++) }),
    );

    expect(outcome.kind).toBe('already_terminal');
    expect(logged(FINALIZE_CLAIMED_ELSEWHERE)).toBe(true);
    expect(proofs).toBe(0);
    expect((await jobRow(jobId)).status).toBe('processing');
    expect((await stateRow(stateId)).decisionStatus).toBe('dirty');
    expect(await runsOf(jobId)).toEqual([]);
  });

  it('le marqueur de l’APPELANT (claim) est accepté ⇒ completed, marqueur levé', async () => {
    const jobId = await insertJob('processing');
    const mine = new Date();
    await db.update(agentJobs).set({ finalizingAt: mine }).where(eq(agentJobs.id, jobId));

    const outcome = await finalizeJobSuccess(
      asDb(),
      { jobId, result: 'par le cron', claim: { finalizingAt: mine } },
      deps(),
    );

    expect(outcome.kind).toBe('completed');
    const [row] = await db
      .select({ status: agentJobs.status, finalizingAt: agentJobs.finalizingAt })
      .from(agentJobs)
      .where(eq(agentJobs.id, jobId));
    expect(row?.status).toBe('completed');
    expect(row?.finalizingAt).toBeNull();
  });

  it('marqueur PÉRIMÉ (finaliseur mort entre ses deux transactions) ⇒ repris et finalisé', async () => {
    const jobId = await insertJob('processing');
    await db
      .update(agentJobs)
      .set({ finalizingAt: new Date(Date.now() - FINALIZING_STALE_MS - 1_000) })
      .where(eq(agentJobs.id, jobId));

    const outcome = await finalizeJobSuccess(asDb(), { jobId, result: 'repris' }, deps());

    expect(outcome.kind).toBe('completed');
    expect((await jobRow(jobId)).status).toBe('completed');
  });

  it('un autre JOB écrit dans le projet PENDANT la preuve (epoch bougé) ⇒ état dirty, VERIFY_STALE_EPOCH, run vert avec l’ancien epoch, job completed quand même (①)', async () => {
    const cmds: VerifyCommand[] = [
      { command: await script('ok-epoch.js', 'process.exit(0)'), timeoutSeconds: 5 },
    ];
    await setProject(cmds, 'current');
    const jobId = await insertJob('processing');
    const stateId = await insertState(jobId, 'code_project', key, 1);
    // Le vrai vérificateur, dont la preuve est précédée d'une écriture d'un
    // AUTRE job dans le même projet : l'intention de T16 avance l'epoch.
    const bumping: DeliverableVerifier = {
      ...codeProjectVerifier,
      runProof: async (config, onCommandDone) => {
        await db
          .update(codeProjects)
          .set({ verificationEpoch: sql`${codeProjects.verificationEpoch} + 1` })
          .where(eq(codeProjects.projectKey, key));
        return codeProjectVerifier.runProof(config, onCommandDone);
      },
    };

    const outcome = await finalizeJobSuccess(
      asDb(),
      { jobId, result: 'ok' },
      deps({ getVerifier: () => bumping }),
    );

    expect(logged(VERIFY_STALE_EPOCH)).toBe(true);
    expect(outcome.kind).toBe('completed_unverified');
    expect(outcome.observedDue).toBe(true);
    const state = await stateRow(stateId);
    expect(state.decisionStatus).toBe('dirty');
    expect(state.verifiedGeneration).toBeNull();
    const runs = await runsOf(jobId);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.verdict).toBe('green');
    expect(runs[0]?.testedEpoch).toBe(7);
    expect((await jobRow(jobId)).status).toBe('completed');
  });
});
