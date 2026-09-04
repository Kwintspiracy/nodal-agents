// finalize-interleaving.pg.test.ts — la primitive terminale sous VRAIE
// concurrence : deux connexions Postgres, deux finaliseurs, un seul job.
//
// PGlite n'a qu'une connexion : tout « concurrent » y est sérialisé, donc
// aucun test PGlite ne prouve un verrou ni une réclamation. Ici (plan
// « Vérifier & Corriger », T14) :
//
//   - intra-job : A est DANS sa preuve (hors transaction, décision n°5) quand
//     B se présente. Sans marqueur, B lancerait SA preuve et l'apprendrait en
//     transaction 2 — le verdict « incomplet » du découpage. Avec la
//     réclamation `finalizing_at` de la transaction 1, B se retire AVANT toute
//     preuve : une seule séquence `verification_runs` pour le job ;
//   - inter-jobs : un AUTRE job écrit dans le même projet pendant la preuve
//     de A (l'intention T16 avance l'epoch) ⇒ A ne finalise pas « vérifié ».
//
// Le démarrage du harnais est un TEST (rouge si le binaire manque, jamais
// sauté — inv. #4). Jamais `describe.skipIf`.

import { describe, it, expect, afterAll } from 'vitest';
import { startRealPostgres, type RealPostgres } from '@nodal-agents/test-kit';
import {
  createClient,
  agentJobs,
  codeProjects,
  jobDeliverableVerificationState,
  verificationRuns,
  eq,
  sql,
} from '@nodal-agents/db';
import type { AnyDrizzleDb } from '@nodal-agents/db';
import { runMigrations } from '@nodal-agents/db/migrate';
import { seedMinimal, type TestDb } from '@nodal-agents/db/test-utils';
import {
  ENV_ALLOWLIST_VERSION,
  SHELL_POLICY_VERSION,
  hashVerificationManifest,
  normalizePath,
  projectKey,
} from '@nodal-agents/shared';
import type { VerifyCommand } from '@nodal-agents/shared';
import {
  FINALIZE_CLAIMED_ELSEWHERE,
  VERIFY_STALE_EPOCH,
  finalizeJobSuccess,
} from '../../job/finalize.ts';
import type { DeliverableVerifier, ProofCommandRecord } from '../../verification/registry.ts';
import { codeProjectVerifier } from '../../verification/code-project.ts';

let pg: RealPostgres | null = null;
let a: ReturnType<typeof createClient> | null = null;
let b: ReturnType<typeof createClient> | null = null;
let seed: { userId: string; entityId: string; agentId: string; jobId: string } | null = null;

const projectPath = normalizePath('D:/tmp/nodal-t14-project');
const key = projectKey(projectPath);

afterAll(async () => {
  await a?.close();
  await b?.close();
  await pg?.stop();
});

function harness() {
  if (!pg || !a || !b || !seed)
    expect.fail('REAL_POSTGRES_NOT_STARTED — le démarrage a échoué avant');
  return {
    url: pg.url,
    a: a.db as unknown as AnyDrizzleDb,
    b: b.db as unknown as AnyDrizzleDb,
    seed,
  };
}

type Log = { code: string; data: Record<string, unknown> }[];
const logger = (into: Log) => (code: string, data: Record<string, unknown>) => {
  into.push({ code, data });
};

async function insertJob(db: AnyDrizzleDb, entityId: string, agentId: string): Promise<string> {
  const [row] = await db
    .insert(agentJobs)
    .values({ entityId, agentId, channel: 'api', task: 'interleaving', status: 'processing' })
    .returning({ id: agentJobs.id });
  if (!row) throw new Error('job insert failed');
  return row.id;
}

async function insertState(db: AnyDrizzleDb, jobId: string): Promise<string> {
  const [row] = await db
    .insert(jobDeliverableVerificationState)
    .values({
      jobId,
      deliverableType: 'code_project',
      canonicalKey: key,
      dirtyGeneration: 1,
      decisionStatus: 'dirty',
    })
    .returning({ id: jobDeliverableVerificationState.id });
  if (!row) throw new Error('state insert failed');
  return row.id;
}

const record = (command: string): ProofCommandRecord => ({
  rank: 0,
  command,
  outcomeKind: 'exit',
  exitCode: 0,
  stdoutTail: '',
  stderrTail: '',
  durationMs: 1,
  verdict: 'green',
});

/** Attend qu'un drapeau se lève — jamais plus de `ms`. */
async function waitFor(flag: () => boolean, ms = 10_000): Promise<void> {
  const until = Date.now() + ms;
  while (!flag()) {
    if (Date.now() > until) throw new Error('WAIT_FOR_TIMEOUT');
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe('harnais', () => {
  it('démarre Postgres, applique les vraies migrations, ouvre deux connexions', async () => {
    pg = await startRealPostgres();
    await runMigrations(pg.url, { patchVectorAsText: true });
    a = createClient(pg.url, { max: 1 });
    b = createClient(pg.url, { max: 1 });
    seed = await seedMinimal(a.db as unknown as TestDb);
  }, 120_000);
});

describe('finalisation sous vraie concurrence', () => {
  it('intra-job : B se présente PENDANT la preuve de A ⇒ B se retire avant toute preuve (FINALIZE_CLAIMED_ELSEWHERE), une seule séquence verification_runs', async () => {
    const h = harness();
    const jobId = await insertJob(h.a, h.seed.entityId, h.seed.agentId);
    await insertState(h.a, jobId);

    let release!: () => void;
    const barrier = new Promise<void>((r) => {
      release = r;
    });
    let aInProof = false;
    let bProofs = 0;
    const logsA: Log = [];
    const logsB: Log = [];

    const stub = (tag: string, onProof: () => Promise<void>): DeliverableVerifier => ({
      deliverableType: 'code_project',
      canonicalize: projectKey,
      loadConfig: async () => ({
        kind: 'ready',
        manifestHash: 'v1:stub',
        cwd: projectPath,
        commands: [{ command: `stub-${tag}`, timeoutSeconds: 1 }],
        epoch: 1,
      }),
      runProof: async (_config, onCommandDone) => {
        await onProof();
        const rec = record(`stub-${tag}`);
        await onCommandDone(rec);
        return { verdict: 'green', records: [rec] };
      },
    });

    // A : transaction 1 commise, puis bloqué DANS sa preuve.
    const aRun = finalizeJobSuccess(
      h.a,
      { jobId, result: 'par A' },
      {
        getVerifier: () =>
          stub('A', async () => {
            aInProof = true;
            await barrier;
          }),
        log: logger(logsA),
      },
    );
    await waitFor(() => aInProof);

    // B : se présente pendant la preuve de A, sur SA connexion.
    const bStarted = Date.now();
    const bOutcome = await finalizeJobSuccess(
      h.b,
      { jobId, result: 'par B' },
      {
        getVerifier: () =>
          stub('B', async () => {
            bProofs += 1;
          }),
        log: logger(logsB),
      },
    );
    const bElapsed = Date.now() - bStarted;

    expect(bOutcome.kind).toBe('already_terminal');
    expect(logsB.some((l) => l.code === FINALIZE_CLAIMED_ELSEWHERE)).toBe(true);
    expect(bProofs).toBe(0);
    // B n'a pas attendu la fin de A : il s'est retiré tout de suite.
    expect(bElapsed).toBeLessThan(5_000);

    release();
    const aOutcome = await aRun;
    expect(aOutcome.kind).toBe('completed');

    const runs = await h.a
      .select({ command: verificationRuns.command, sequenceId: verificationRuns.sequenceId })
      .from(verificationRuns)
      .where(eq(verificationRuns.jobId, jobId));
    expect(runs).toHaveLength(1);
    expect(runs[0]?.command).toBe('stub-A');

    const [job] = await h.a
      .select({ status: agentJobs.status, finalizingAt: agentJobs.finalizingAt })
      .from(agentJobs)
      .where(eq(agentJobs.id, jobId));
    expect(job?.status).toBe('completed');
    expect(job?.finalizingAt).toBeNull();
  }, 30_000);

  it('inter-jobs : un AUTRE job écrit dans le projet pendant la preuve de A (epoch avancé sur l’autre connexion) ⇒ A finit dirty + VERIFY_STALE_EPOCH, job completed quand même (①)', async () => {
    const h = harness();
    const commands: VerifyCommand[] = [{ command: 'stub', timeoutSeconds: 1 }];
    const manifestHash = hashVerificationManifest({
      verifierConfig: commands,
      invariants: [],
      canonicalKey: key,
      cwd: projectPath,
      shellPolicyVersion: SHELL_POLICY_VERSION,
      envAllowlistVersion: ENV_ALLOWLIST_VERSION,
    });
    await h.a
      .insert(codeProjects)
      .values({
        entityId: h.seed.entityId,
        projectPath,
        projectKey: key,
        verifyCommands: commands,
        verificationEpoch: 7,
        verifyApprovedManifestHash: manifestHash,
      })
      .onConflictDoNothing();
    const jobId = await insertJob(h.a, h.seed.entityId, h.seed.agentId);
    const stateId = await insertState(h.a, jobId);

    let release!: () => void;
    const barrier = new Promise<void>((r) => {
      release = r;
    });
    let inProof = false;
    const logs: Log = [];
    // Le vrai vérificateur (loadConfig réel, sous verrou) ; la preuve est
    // remplacée par une barrière : c'est le SCHÉMA que l'on teste, pas un
    // spawn.
    const verifier: DeliverableVerifier = {
      ...codeProjectVerifier,
      runProof: async (_config, onCommandDone) => {
        inProof = true;
        await barrier;
        const rec = record('stub');
        await onCommandDone(rec);
        return { verdict: 'green', records: [rec] };
      },
    };

    const aRun = finalizeJobSuccess(
      h.a,
      { jobId, result: 'par A' },
      { getVerifier: () => verifier, log: logger(logs) },
    );
    await waitFor(() => inProof);

    // L'autre job, sur l'autre connexion : l'intention avance l'epoch du
    // projet sous FOR UPDATE, comme le fait T16.
    await h.b.transaction(async (tx) => {
      await tx
        .select({ id: codeProjects.id })
        .from(codeProjects)
        .where(eq(codeProjects.projectKey, key))
        .for('update');
      await tx
        .update(codeProjects)
        .set({ verificationEpoch: sql`${codeProjects.verificationEpoch} + 1` })
        .where(eq(codeProjects.projectKey, key));
    });

    release();
    const outcome = await aRun;

    expect(outcome.kind).toBe('completed_unverified');
    expect(outcome.observedDue).toBe(true);
    expect(logs.some((l) => l.code === VERIFY_STALE_EPOCH)).toBe(true);
    const [state] = await h.a
      .select({
        decisionStatus: jobDeliverableVerificationState.decisionStatus,
        verifiedGeneration: jobDeliverableVerificationState.verifiedGeneration,
      })
      .from(jobDeliverableVerificationState)
      .where(eq(jobDeliverableVerificationState.id, stateId));
    expect(state?.decisionStatus).toBe('dirty');
    expect(state?.verifiedGeneration).toBeNull();
    const runs = await h.a
      .select({ verdict: verificationRuns.verdict, testedEpoch: verificationRuns.testedEpoch })
      .from(verificationRuns)
      .where(eq(verificationRuns.jobId, jobId));
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ verdict: 'green', testedEpoch: 7 });
    const [job] = await h.a
      .select({ status: agentJobs.status })
      .from(agentJobs)
      .where(eq(agentJobs.id, jobId));
    expect(job?.status).toBe('completed');
  }, 30_000);
});
