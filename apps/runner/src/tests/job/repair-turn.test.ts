// repair-turn.test.ts — une preuve rouge rouvre le run pour UN tour, jamais deux.
//
// Ce que ces tests prouvent, sur de vraies lignes et de vrais processus
// (issue #375, décision D2 du plan « Vérifier & Corriger ») :
//
//  - preuve ROUGE et aucune réparation encore faite ⇒ le job N'EST PAS
//    terminal, `repair_attempts` passe à 1, la réclamation est relâchée, la
//    reprise est comptée sur `chain_count`, et le brief rendu porte la
//    commande, son code de sortie et sa sortie CAPTURÉE, verbatim ;
//  - preuve rouge une SECONDE fois ⇒ `completed`, `red_streak = 1`, aucun
//    troisième tour ;
//  - verte après réparation ⇒ `completed`, verdict `green`, `red_streak` à
//    zéro ;
//  - un job ANNULÉ n'entre jamais en réparation ;
//  - une porte qui ne sait pas rouvrir son job (`repairTurn: 'unsupported'`)
//    garde le comportement de PR① : le rouge finit `completed_unverified`.

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import {
  eq,
  agentJobs,
  codeProjects,
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
import { VERIFY_REPAIR_TURN_OPENED, finalizeJobSuccess } from '../../job/finalize.ts';
import type { FinalizeDeps } from '../../job/finalize.ts';
import { REPAIR_BRIEF_TAIL_CHARS, buildRepairBrief } from '../../verification/repair-brief.ts';

// Ces tests lancent de VRAIS processus : sous la charge de la suite complète,
// une preuve d'une seconde en prend huit.
vi.setConfig({ testTimeout: 30_000 });

let db: TestDb;
let seed: { userId: string; entityId: string; agentId: string; jobId: string };
let dir: string;
let projectPath: string;
let key: string;
const node = process.execPath;

const asDb = (): Parameters<typeof finalizeJobSuccess>[0] =>
  db as unknown as Parameters<typeof finalizeJobSuccess>[0];

let logs: { code: string; data: Record<string, unknown> }[] = [];
const deps = (): FinalizeDeps => ({ log: (code, data) => logs.push({ code, data }) });
const logged = (code: string): boolean => logs.some((l) => l.code === code);

beforeAll(async () => {
  const spun = await spinUpTestDb();
  db = spun.db;
  seed = await seedMinimal(db);
  dir = await mkdtemp(join(tmpdir(), 'nodal-repair-'));
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

/** Écrit le script et rend la COMMANDE qui le lance — la commande ne bouge plus. */
async function script(name: string, body: string): Promise<string> {
  const p = join(dir, name);
  await writeFile(p, body, 'utf8');
  return `"${node}" "${p}"`;
}

/** Réécrit le corps d'un script déjà déclaré : la commande, elle, est la même. */
async function rewrite(name: string, body: string): Promise<void> {
  await writeFile(join(dir, name), body, 'utf8');
}

const manifestHashOf = (commands: VerifyCommand[]): string =>
  hashVerificationManifest({
    verifierConfig: commands,
    invariants: [],
    canonicalKey: key,
    cwd: projectPath,
    shellPolicyVersion: SHELL_POLICY_VERSION,
    envAllowlistVersion: ENV_ALLOWLIST_VERSION,
  });

async function setProject(commands: VerifyCommand[]): Promise<void> {
  await db.insert(codeProjects).values({
    entityId: seed.entityId,
    projectPath,
    projectKey: key,
    verifyCommands: commands,
    verificationEpoch: 7,
    verifyApprovedManifestHash: manifestHashOf(commands),
  });
}

async function insertJob(status: string): Promise<string> {
  const [row] = await db
    .insert(agentJobs)
    .values({
      entityId: seed.entityId,
      agentId: seed.agentId,
      channel: 'api',
      task: 'repair turn test',
      status,
      chainCount: 0,
    })
    .returning({ id: agentJobs.id });
  if (!row) throw new Error('job insert failed');
  return row.id;
}

async function insertState(jobId: string, dirtyGeneration = 1): Promise<string> {
  const [row] = await db
    .insert(jobDeliverableVerificationState)
    .values({
      jobId,
      deliverableType: 'code_project',
      canonicalKey: key,
      dirtyGeneration,
      decisionStatus: 'dirty',
      produced: true,
      displayPathSnapshot: projectPath,
    })
    .returning({ id: jobDeliverableVerificationState.id });
  if (!row) throw new Error('state insert failed');
  return row.id;
}

const stateRow = async (
  stateId: string,
): Promise<{ decisionStatus: string; redStreak: number; repairAttempts: number }> => {
  const [row] = await db
    .select({
      decisionStatus: jobDeliverableVerificationState.decisionStatus,
      redStreak: jobDeliverableVerificationState.redStreak,
      repairAttempts: jobDeliverableVerificationState.repairAttempts,
    })
    .from(jobDeliverableVerificationState)
    .where(eq(jobDeliverableVerificationState.id, stateId));
  if (!row) throw new Error('state not found');
  return row;
};

const jobRow = async (
  jobId: string,
): Promise<{
  status: string | null;
  completedAt: Date | null;
  chainCount: number | null;
  finalizingAt: Date | null;
}> => {
  const [row] = await db
    .select({
      status: agentJobs.status,
      completedAt: agentJobs.completedAt,
      chainCount: agentJobs.chainCount,
      finalizingAt: agentJobs.finalizingAt,
    })
    .from(agentJobs)
    .where(eq(agentJobs.id, jobId));
  if (!row) throw new Error('job not found');
  return row;
};

const finalize = (jobId: string, repairTurn: 'supported' | 'unsupported' = 'supported') =>
  finalizeJobSuccess(
    asDb(),
    { jobId, result: 'livré', resultKind: 'prose', repairTurn, toolsUsed: ['return_result'] },
    deps(),
  );

describe('une preuve rouge rouvre le run pour UN tour @cap:verifier-un-livrable/moteur', () => {
  it('premier rouge : le job n’est PAS terminal, repair_attempts passe à 1, le brief porte la commande et sa sortie', async () => {
    const red = await script(
      'red.js',
      "process.stdout.write('running 6 proofs\\n'); process.stderr.write('AssertionError: expected 1 to be 2\\n'); process.exit(3)",
    );
    await setProject([{ command: red, timeoutSeconds: 20 }]);
    const jobId = await insertJob('processing');
    const stateId = await insertState(jobId);

    const outcome = await finalize(jobId);

    expect(outcome.kind).toBe('repair_due');
    expect(outcome.observedOutcome).toBe('repair_due');
    expect(logged(VERIFY_REPAIR_TURN_OPENED)).toBe(true);

    // Le job repart : aucun statut terminal, aucune date de fin.
    const job = await jobRow(jobId);
    expect(job.status).toBe('processing');
    expect(job.completedAt).toBeNull();
    // La réclamation est relâchée, sinon la finalisation d’après se retirerait
    // dix minutes durant.
    expect(job.finalizingAt).toBeNull();
    // Le tour compte pour UNE reprise, et une seule.
    expect(job.chainCount).toBe(1);

    const state = await stateRow(stateId);
    expect(state.repairAttempts).toBe(1);
    expect(state.decisionStatus).toBe('red');
    // Le rouge n’est pas encore le dernier mot : rien n’est compté.
    expect(state.redStreak).toBe(0);

    // Le message du tour suivant : la commande, son code de sortie, sa sortie.
    const brief = outcome.repair?.brief ?? '';
    expect(brief).toContain(red);
    expect(brief).toContain('Exit code: 3');
    expect(brief).toContain('AssertionError: expected 1 to be 2');
    expect(brief).toContain('running 6 proofs');
    expect(brief).toContain(projectPath);
  });

  it('rouge une SECONDE fois : completed, red_streak à 1, aucun troisième tour', async () => {
    const red = await script('red2.js', "process.stderr.write('still red'); process.exit(1)");
    await setProject([{ command: red, timeoutSeconds: 20 }]);
    const jobId = await insertJob('processing');
    const stateId = await insertState(jobId);

    const premier = await finalize(jobId);
    expect(premier.kind).toBe('repair_due');

    // L’agent a « réparé » et relivré : la preuve repasse, et rougit encore.
    const second = await finalize(jobId);

    expect(second.kind).toBe('completed_unverified');
    expect(second.observedOutcome).toBe('verification_due');
    expect(second.repair).toBeUndefined();

    const job = await jobRow(jobId);
    expect(job.status).toBe('completed');
    expect(job.completedAt).toBeTruthy();
    // La reprise du premier tour, et rien de plus.
    expect(job.chainCount).toBe(1);

    const state = await stateRow(stateId);
    expect(state.decisionStatus).toBe('red');
    expect(state.redStreak).toBe(1);
    expect(state.repairAttempts).toBe(1);
  });

  it('verte après réparation : completed, verdict green, red_streak à zéro', async () => {
    const cmd = await script('fixme.js', "process.stderr.write('boum'); process.exit(1)");
    await setProject([{ command: cmd, timeoutSeconds: 20 }]);
    const jobId = await insertJob('processing');
    const stateId = await insertState(jobId);

    expect((await finalize(jobId)).kind).toBe('repair_due');

    // La réparation : le MÊME appel de commande, un code corrigé.
    await rewrite('fixme.js', 'process.exit(0)');
    const second = await finalize(jobId);

    expect(second.kind).toBe('completed');
    expect(second.decisions[0]?.decisionStatus).toBe('green');

    const job = await jobRow(jobId);
    expect(job.status).toBe('completed');

    const state = await stateRow(stateId);
    expect(state.decisionStatus).toBe('green');
    expect(state.redStreak).toBe(0);
    expect(state.repairAttempts).toBe(1);
  });

  it('un job ANNULÉ n’entre jamais en réparation', async () => {
    const red = await script('red3.js', "process.stderr.write('boum'); process.exit(1)");
    await setProject([{ command: red, timeoutSeconds: 20 }]);
    const jobId = await insertJob('cancelled');
    const stateId = await insertState(jobId);

    const outcome = await finalize(jobId);

    expect(outcome.kind).toBe('already_terminal');
    expect(outcome.repair).toBeUndefined();

    const state = await stateRow(stateId);
    expect(state.repairAttempts).toBe(0);
    expect(state.decisionStatus).toBe('dirty');

    const job = await jobRow(jobId);
    expect(job.status).toBe('cancelled');
    expect(job.chainCount).toBe(0);
  });

  it('une porte qui ne sait pas rouvrir son job garde le comportement de PR①', async () => {
    const red = await script('red4.js', "process.stderr.write('boum'); process.exit(1)");
    await setProject([{ command: red, timeoutSeconds: 20 }]);
    const jobId = await insertJob('processing');
    const stateId = await insertState(jobId);

    const outcome = await finalize(jobId, 'unsupported');

    expect(outcome.kind).toBe('completed_unverified');
    expect(outcome.repair).toBeUndefined();
    expect((await jobRow(jobId)).status).toBe('completed');

    const state = await stateRow(stateId);
    expect(state.repairAttempts).toBe(0);
    expect(state.redStreak).toBe(1);
  });
});

describe('le brief de réparation borne la sortie et le DIT @cap:verifier-un-livrable/moteur', () => {
  const record = (stdoutTail: string) => ({
    rank: 1,
    command: 'pnpm test',
    outcomeKind: 'exit' as const,
    exitCode: 1,
    stdoutTail,
    stderrTail: '',
    durationMs: 12,
    verdict: 'red' as const,
  });

  it('une sortie plus longue que la borne garde la FIN, et la troncature est annoncée', () => {
    const long = `${'x'.repeat(REPAIR_BRIEF_TAIL_CHARS + 500)}DERNIERE_LIGNE`;
    const brief = buildRepairBrief([{ deliverable: 'D:/p', record: record(long) }]);

    expect(brief).toContain('DERNIERE_LIGNE');
    expect(brief).toContain(
      `kept the last ${REPAIR_BRIEF_TAIL_CHARS} characters of ${long.length}`,
    );
    expect(brief).not.toContain('x'.repeat(REPAIR_BRIEF_TAIL_CHARS + 1));
  });

  it('une commande muette le dit, plutôt que de rendre une section vide', () => {
    const brief = buildRepairBrief([{ deliverable: 'D:/p', record: record('') }]);
    expect(brief).toContain('the command printed nothing');
  });

  it('sans aucune commande rouge, il refuse plutôt que de composer un brief vide', () => {
    expect(() => buildRepairBrief([])).toThrow('REPAIR_BRIEF_WITHOUT_RED_COMMAND');
  });
});
