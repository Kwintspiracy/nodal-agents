// cron/reset-orphans.ts — resetOrphanedTasks + resetOrphanedJobs
// Two cleanup phases for state left behind by abrupt shutdown (Ctrl+C, crash,
// suspended laptop). Without these, the dashboard accumulates stuck rows that
// can never recover on their own.
//   - resetOrphanedTasks: tasks claimed but never executed → back to `todo`
//   - resetOrphanedJobs:  jobs waiting (`awaiting_delegation`,
//                         `awaiting_approval`) for something that already
//                         happened → given it; unrepairable → `failed`
// What is dead and what is stuck is decided by `decideJob` (job/liveness.ts).

import { and, eq, inArray, isNull, lt, or, sql } from '@nodal-agents/db';
import {
  agentJobs,
  agentTasks,
  approvalRequests,
  CALL_GATE_KINDS,
  gatesACall,
} from '@nodal-agents/db';
import { expirePendingRequests } from '@nodal-agents/db';
import type { AnyDrizzleDb, SweeperObservation } from '@nodal-agents/db';
import { appendDeliveredVerdicts, readJobDeliverable } from '@nodal-agents/orchestration';
import type { JobId } from '@nodal-agents/orchestration';
import { failJob } from '../job/state.ts';
import { resumeJobAfterApprovalResolution } from '../approvals/resume.ts';
import { closeElicitationsOfLostJobs } from '../approvals/elicitation.ts';
import { takeLostRun } from './take-lost-run.ts';
import { sweptJobStopLine } from './stop-line.ts';
import { maybeResumeParent } from '../job/execute.ts';
import type { ExecuteJobResult } from '../job/execute.ts';
import { DB_NOW_MS, JOB_LIVENESS, decideJob, processPresence } from '../job/liveness.ts';
import type { JobFacts, JobLivenessSettings, JobVerdict, Presence } from '../job/liveness.ts';
import type { RunnerEnv } from '../env.ts';

// What a reaper says when it fails a job is what the row tells it (the status,
// how long since the last update on the database clock, how a delegated job it
// waited on ended), in the runner's stop-line form (`sweptJobStopLine`,
// cron/stop-line.ts), never a guessed cause. The person reads it where they
// asked: `failJob` prepares the notice of every failure, in its own
// transaction (#1180, #1086).

// ─── resetOrphanedTasks ───────────────────────────────────────────────────────

/**
 * Reset tasks that are `in_progress` but have no `job_id` and have been
 * stuck for more than `staleMinutes` minutes (default 5).
 *
 * This covers the case where the machine suspended between the atomic claim
 * (status → in_progress) and the job creation step. Without this reset those
 * tasks would be stuck forever.
 *
 * Also FINALIZES tasks whose linked job has already reached a terminal state
 * (completed / failed / cancelled) but were never marked — mirrors the job
 * outcome onto the task (done / blocked). It must NEVER reset such a task to
 * `todo`: re-running a task whose job already completed re-executes successful
 * work (live: the same agent posted to its MCP endpoint 3x). With the per-job marking
 * in executeReadyTasks this is now a rare safety net (genuine crash between job
 * finish and task mark), not the common path.
 *
 * @returns count of tasks reset/finalized
 */
export async function resetOrphanedTasks(db: AnyDrizzleDb, staleMinutes = 5): Promise<number> {
  const cutoff = new Date(Date.now() - staleMinutes * 60 * 1000);

  // Case A: in_progress with no job_id, locked_at older than cutoff
  const caseA = await db
    .update(agentTasks)
    .set({
      status: 'todo',
      lockedBy: null,
      lockedAt: null,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(agentTasks.status, 'in_progress'),
        isNull(agentTasks.jobId),
        or(isNull(agentTasks.lockedAt), lt(agentTasks.lockedAt, cutoff)),
      ),
    )
    .returning({ id: agentTasks.id });

  // Case B: in_progress tasks whose linked job has already reached a terminal
  // state but were never marked. Mirror the job outcome onto the task — done if
  // the job completed, blocked if it failed/cancelled — NEVER reset to 'todo'
  // (which re-runs already-completed work). Pull the job status + result in one
  // join, then finalize each terminal one with a conditional UPDATE.
  const TERMINAL_JOB_STATUSES = ['completed', 'failed', 'cancelled'];
  const inProgressTasks = await db
    .select({
      taskId: agentTasks.id,
      jobId: agentJobs.id,
      jobStatus: agentJobs.status,
      jobResult: agentJobs.result,
      jobError: agentJobs.error,
    })
    .from(agentTasks)
    .innerJoin(agentJobs, eq(agentTasks.jobId, agentJobs.id))
    .where(eq(agentTasks.status, 'in_progress'));

  let caseBCount = 0;
  for (const t of inProgressTasks) {
    if (!t.jobStatus || !TERMINAL_JOB_STATUSES.includes(t.jobStatus)) continue;
    const taskStatus = t.jobStatus === 'completed' ? 'done' : 'blocked';
    // Le texte du job, suivi des verdicts que son sous-arbre a livrés — le
    // lecteur unique de « ce qu'un job a livré » (#646), le même que celui de
    // `markTaskFromResult`. Un job annulé n'a rien livré à recopier.
    const delivered = t.jobStatus === 'cancelled' ? null : await readJobDeliverable(db, t.jobId);
    const taskResult =
      t.jobStatus === 'completed'
        ? appendDeliveredVerdicts(t.jobResult ?? '', delivered)
        : appendDeliveredVerdicts(
            t.jobResult ?? t.jobError ?? 'job ended without a result',
            delivered,
          );
    const updated = await db
      .update(agentTasks)
      .set({
        status: taskStatus,
        result: taskResult,
        lockedBy: null,
        lockedAt: null,
        updatedAt: new Date(),
      })
      .where(and(eq(agentTasks.id, t.taskId), eq(agentTasks.status, 'in_progress')))
      .returning({ id: agentTasks.id });
    caseBCount += updated.length;
  }

  return caseA.length + caseBCount;
}

// ─── resetOrphanedJobs ────────────────────────────────────────────────────────

/** Ce qu'un job en attente attend, lu pour `decideJob`. */
interface WaitingRow {
  readonly id: string;
  readonly status: 'awaiting_delegation' | 'awaiting_approval';
  readonly claimGeneration: number;
  readonly claimedBy: string | null;
  readonly dbNow: Date;
  /** The row's last update, for the line the person reads. */
  readonly updatedAt: Date | null;
  readonly facts: JobFacts;
  readonly signature: string;
  /** L'enfant attendu, pour une délégation enregistrée. */
  readonly child: ChildRow | null;
}

interface ChildRow {
  readonly id: string;
  readonly status: string | null;
  readonly result: string | null;
  readonly error: string | null;
  readonly toolsUsed: string[] | null;
}

/**
 * L'issue d'un enfant terminé telle que SA ligne la dit, dans la forme que le
 * chemin normal donne à `maybeResumeParent` : la même réparation que la fin
 * normale d'une délégation, jamais une forme à part.
 */
function outcomeOfEndedChild(
  child: ChildRow,
): Extract<ExecuteJobResult, { status: 'completed' | 'failed' | 'cancelled' }> | null {
  switch (child.status) {
    case 'completed':
      return { status: 'completed', result: child.result ?? '', toolsUsed: child.toolsUsed ?? [] };
    case 'failed':
      return {
        status: 'failed',
        error: child.error ?? 'unknown',
        ...(child.result !== null ? { result: child.result } : {}),
        toolsUsed: child.toolsUsed ?? [],
      };
    case 'cancelled':
      return { status: 'cancelled' };
    default:
      return null;
  }
}

/**
 * Les jobs qui ATTENDENT quelque chose qui a peut-être déjà eu lieu (#1204) :
 *   - un parent `awaiting_delegation` dont l'enfant a fini, mais dont la
 *     reprise s'est perdue (un crash entre la fin de l'enfant et
 *     `maybeResumeParent`, une exception rattrapée) : il REÇOIT le résultat
 *     de son enfant, par `maybeResumeParent`, la fonction du chemin normal —
 *     jamais plus l'échec « le service a redémarré » d'avant, avec le résultat
 *     de l'enfant resté inutilisé en base (B31-16) ;
 *   - un job `awaiting_approval` dont toutes les demandes ont été tranchées
 *     ou ont expiré sans que le job reparte (B31-10) : il REPART, par
 *     `resumeJobAfterApprovalResolution`, la fonction des chemins humain et
 *     d'expiration.
 * Seul ce que rien ne peut réparer échoue : un parent qui n'enregistre aucune
 * délégation, ou dont l'enfant n'existe pas. La décision est `decideJob`, et
 * aucune n'est prise sur l'âge d'une date : une ligne qu'aucun run de ce
 * processus n'exécute, vue inchangée assez longtemps sur l'horloge monotone de
 * ce processus, est une ligne dont le réveil s'est perdu.
 *
 * Un job `processing` n'est plus regardé ici : il appartient à
 * `reclaimJobsOfDeadRunners`, qui le juge sur son détenteur.
 *
 * @returns le nombre de jobs passés en `failed`
 */
export async function resetOrphanedJobs(
  db: AnyDrizzleDb,
  opts: { presence?: Presence; settings?: JobLivenessSettings; runnerEnv?: RunnerEnv } = {},
): Promise<number> {
  const presence = opts.presence ?? processPresence;
  const settings = opts.settings ?? JOB_LIVENESS;

  const candidates = await db
    .select({
      id: agentJobs.id,
      status: agentJobs.status,
      claimGeneration: agentJobs.claimGeneration,
      claimedBy: agentJobs.claimedBy,
      updatedAt: agentJobs.updatedAt,
      pendingDelegation: agentJobs.pendingDelegation,
      dbNowMs: DB_NOW_MS,
    })
    .from(agentJobs)
    .where(inArray(agentJobs.status, ['awaiting_delegation', 'awaiting_approval']));

  const rows: WaitingRow[] = [];
  for (const c of candidates) {
    const dbNow = new Date(Number(c.dbNowMs));
    const base = `${c.status ?? ''}|${String(c.claimGeneration)}|${String(c.updatedAt?.getTime() ?? 0)}`;
    if (c.status === 'awaiting_delegation') {
      const subId = (c.pendingDelegation as { subJobId?: string } | null)?.subJobId ?? null;
      let child: ChildRow | null = null;
      if (subId) {
        const [sub] = await db
          .select({
            id: agentJobs.id,
            status: agentJobs.status,
            result: agentJobs.result,
            error: agentJobs.error,
            toolsUsed: agentJobs.toolsUsed,
          })
          .from(agentJobs)
          .where(eq(agentJobs.id, subId))
          .limit(1);
        child = sub ?? { id: subId, status: null, result: null, error: null, toolsUsed: null };
      }
      rows.push({
        id: c.id,
        status: 'awaiting_delegation',
        claimGeneration: c.claimGeneration,
        claimedBy: c.claimedBy,
        dbNow,
        updatedAt: c.updatedAt,
        child,
        signature: `${base}|${child?.id ?? ''}|${child?.status ?? ''}`,
        facts: {
          status: 'awaiting_delegation',
          inFlightHere: presence.holds(c.id) || (child !== null && presence.holds(child.id)),
          child: child === null ? null : { status: child.status },
          stuckForMs: null,
        },
      });
      continue;
    }
    const demandes = await db
      .select({ status: approvalRequests.status, executedAt: approvalRequests.executedAt })
      .from(approvalRequests)
      .where(and(eq(approvalRequests.jobId, c.id), gatesACall()));
    const ouvertes = demandes.filter((d) => d.status === 'pending').length;
    // Tranchée ou échue, et pas encore exécutée : la même lecture que
    // `reviveJobIfApprovalResolvedDuringSuspend` (job/execute.ts).
    const tranchees = demandes.filter(
      (d) =>
        (d.status === 'approved' || d.status === 'rejected' || d.status === 'expired') &&
        d.executedAt === null,
    ).length;
    rows.push({
      id: c.id,
      status: 'awaiting_approval',
      claimGeneration: c.claimGeneration,
      claimedBy: c.claimedBy,
      dbNow,
      updatedAt: c.updatedAt,
      child: null,
      signature: `${base}|${String(ouvertes)}|${String(tranchees)}`,
      facts: {
        status: 'awaiting_approval',
        inFlightHere: presence.holds(c.id),
        openRequests: ouvertes,
        resolvedRequests: tranchees,
        stuckForMs: null,
      },
    });
  }

  const vus = presence.stuck.waiting.observe(rows, presence.monotonicNow());

  const toReset: { row: WaitingRow; reason: SweeperObservation['reason']; detail?: string }[] = [];
  let repaired = 0;
  for (const row of rows) {
    const verdict = decideJob({ ...row.facts, stuckForMs: vus.get(row.id) ?? null }, settings);
    switch (verdict.kind) {
      case 'give_child_result': {
        const child = row.child;
        const outcome = child ? outcomeOfEndedChild(child) : null;
        if (!child || !outcome) break;
        try {
          await maybeResumeParent(child.id as JobId, outcome, { db }, opts.runnerEnv);
        } catch (err) {
          // Le résultat existe et le parent le refuse (une ligne d'avant les
          // champs de délégation, un autre enfant attendu) : rien ne le
          // réparera. DIT, puis échoué avec ce fait.
          const detail = err instanceof Error ? err.message : String(err);
          console.error(
            `[reset-orphans] parent=${row.id} child=${child.id} — the child's result could not be given: ${detail}`,
          );
          const [encore] = await db
            .select({ status: agentJobs.status })
            .from(agentJobs)
            .where(eq(agentJobs.id, row.id))
            .limit(1);
          if (encore?.status === 'awaiting_delegation') {
            toReset.push({ row, reason: 'child_result_refused', detail });
          }
          break;
        }
        repaired += 1;
        console.warn(
          `[reset-orphans] parent=${row.id} given the result of child=${child.id} (${child.status ?? ''})`,
        );
        break;
      }
      case 'resume_after_approval': {
        const r = await resumeJobAfterApprovalResolution(db, row.id, opts.runnerEnv);
        if (r.resumed === 'worker') {
          repaired += 1;
          console.warn(`[reset-orphans] job=${row.id} resumed after its approval was resolved`);
        }
        break;
      }
      case 'fail':
        toReset.push({ row, reason: verdict.reason });
        break;
      default:
        break;
    }
  }
  if (repaired > 0) {
    console.warn(
      `[reset-orphans] ${String(repaired)} waiting job(s) resumed with what they waited for`,
    );
  }

  // Finalize each via failJob rather than one blanket UPDATE (D1/D2, audit
  // followup). failJob is (a) conditional on the row NOT being terminal, so a
  // job that legitimately finished between the snapshot above and now is NOT
  // clobbered from completed→failed (D2 — the old bulk UPDATE keyed only on id),
  // and (b) fills the user-facing `result` with an explanation so the outcome is
  // never silent (D1), and prepares its notice where the request was made.
  let reset = 0;
  for (const { row, reason, detail } of toReset) {
    const jobId = row.id;
    const seen = {
      id: row.id,
      status: row.status,
      claimGeneration: row.claimGeneration,
    };
    // Avant l'écriture, la règle des faucheurs (`takeLostRun`) : la ligne
    // prise au run perdu et ses processus morts, ou rien.
    if ((await takeLostRun(db, seen, presence.instanceId)) === null) continue;
    // Le fait lu sur l'enfant attendu, quand il y en a un : il entre dans la
    // ligne d'arrêt (#1086 : « le service a redémarré » pour un enfant annulé).
    const line = sweptJobStopLine({
      status: row.status,
      idleMs: row.dbNow.getTime() - (row.updatedAt?.getTime() ?? row.dbNow.getTime()),
      ...(row.child !== null ? { awaitedJob: { status: row.child.status } } : {}),
    });
    const landed = await failJob(
      db,
      jobId,
      'orphan_job_reset',
      undefined,
      undefined,
      line,
      undefined,
      {
        runnerLines: [line],
      },
    );
    if (landed) {
      reset += 1;
      // Le FAIT, porté par le job (#1204) : ce que le faucheur a constaté.
      await db
        .update(agentJobs)
        .set({
          sweeperObserved: {
            outcome: 'failed',
            reason,
            holder: row.claimedBy,
            holderState: null,
            holderLastSeenAt: null,
            holderStoppedAt: null,
            childJobId: row.child?.id ?? null,
            childStatus: row.child?.status ?? null,
            ...(detail !== undefined ? { detail } : {}),
            observedBy: presence.instanceId,
            observedAt: row.dbNow.toISOString(),
          },
        })
        .where(eq(agentJobs.id, jobId));
      await closeElicitationsOfLostJobs(db, [jobId]);
    }
  }

  return reset;
}

// ─── pending recovery ─────────────────────────────────────────────────────────

/** Les jobs `pending`, avec ce que `decideJob` en sait. */
async function pendingVerdicts(
  db: AnyDrizzleDb,
  presence: Presence,
  settings: JobLivenessSettings,
): Promise<
  {
    id: string;
    claimGeneration: number;
    dbNow: Date;
    updatedAt: Date | null;
    verdict: JobVerdict;
  }[]
> {
  const rows = await db
    .select({
      id: agentJobs.id,
      claimGeneration: agentJobs.claimGeneration,
      updatedAt: agentJobs.updatedAt,
      // L'âge de la DEMANDE, sur la seule horloge de la base : `created_at`
      // est posé par elle (DEFAULT now()), et lu contre son `now()`.
      requestAgeMs: sql<string>`(extract(epoch from (now() - ${agentJobs.createdAt})) * 1000)::bigint`,
      dbNowMs: DB_NOW_MS,
    })
    .from(agentJobs)
    .where(eq(agentJobs.status, 'pending'));
  const vus = presence.stuck.pending.observe(
    rows.map((r) => ({
      id: r.id,
      signature: `${String(r.claimGeneration)}|${String(r.updatedAt?.getTime() ?? 0)}`,
    })),
    presence.monotonicNow(),
  );
  return rows.map((r) => ({
    id: r.id,
    claimGeneration: r.claimGeneration,
    dbNow: new Date(Number(r.dbNowMs)),
    updatedAt: r.updatedAt,
    verdict: decideJob(
      {
        status: 'pending',
        inFlightHere: presence.holds(r.id),
        neverClaimed: r.claimGeneration === 0,
        requestAgeMs: Number(r.requestAgeMs),
        stuckForMs: vus.get(r.id) ?? null,
      },
      settings,
    ),
  }));
}

/**
 * The `pending` jobs whose wake-up was lost, for the caller to drive through
 * executeJob.
 *
 * Why this exists: the Telegram poller (and other job creators) call
 * `triggerWorker(jobId)` fire-and-forget over HTTP to `/api/worker`.
 * That fetch has a `.catch(() => {})` swallow — any transient failure
 * (runner mid-restart, port held by a stale-zombie process on Windows
 * see `feedback_windows_process_tree_kill`, network blip) drops the
 * job into `pending` forever because nothing else periodically claims
 * stale pending rows.
 *
 * Observed live (2026-05-26, job e846a3e1): the user sent a Telegram
 * message, the poller inserted the row, the triggerWorker fetch hit a
 * zombie runner on port 3001 instead of the live one, fetch silently
 * failed, job sat pending for 3+ minutes with no recovery path.
 *
 * Which rows (`decideJob`, #1204): a `pending` row that no run of this
 * process is executing, seen unchanged by this process for
 * `JOB_LIVENESS.stuckRowMs` on its monotonic clock — never the age of a date,
 * which a clock step shortens. A request that no runner ever claimed and that
 * is older than `JOB_LIVENESS.pendingAbandonMs` is left to
 * `failStalePendingJobs` instead: silently waking up a 4-day-old task would
 * be a horror-show UX (live miss 2026-05-26, job 03cd4304). A job the system
 * put back in the queue (a resume after a restart, a parent given its child's
 * result) is a continuation, and is started whatever its age.
 *
 * We DON'T touch the row here — the caller passes each id to
 * executeJob, which atomically claims via `claimJob` (status flip with
 * WHERE), so two concurrent ticks can't double-execute the same job.
 */
export async function findPendingJobsToRecover(
  db: AnyDrizzleDb,
  opts: { presence?: Presence; settings?: JobLivenessSettings } = {},
): Promise<string[]> {
  const presence = opts.presence ?? processPresence;
  const settings = opts.settings ?? JOB_LIVENESS;
  const verdicts = await pendingVerdicts(db, presence, settings);
  return verdicts.filter((v) => v.verdict.kind === 'start').map((v) => v.id);
}

/**
 * Mark as failed the `pending` requests that no runner ever claimed and that
 * are older than `JOB_LIVENESS.pendingAbandonMs` on the database's clock, so
 * they don't sit forever in the DB as junk and — more importantly — don't get
 * silently resurrected by recovery on a later boot. A job that was claimed
 * once (`claim_generation > 0`) and put back in the queue is never abandoned
 * here: it is a continuation, and the recovery starts it (#1204).
 *
 * The error code is distinct from `orphan_job_reset` (which is for
 * processing/awaiting jobs) so the dashboard can tell users "this job
 * was never picked up by a worker" vs "this job started but the runner
 * crashed mid-flight" — different remediation.
 */
export async function failStalePendingJobs(
  db: AnyDrizzleDb,
  opts: { presence?: Presence; settings?: JobLivenessSettings } = {},
): Promise<number> {
  const presence = opts.presence ?? processPresence;
  const settings = opts.settings ?? JOB_LIVENESS;
  // Select the candidates, then finalize each via failJob so the user gets a
  // `result` explanation AND a channel notice — never a silent abandon (D1).
  // failJob's non-terminal guard also protects against a job that flipped out of
  // pending between this select and the write.
  const stale = (await pendingVerdicts(db, presence, settings)).filter(
    (v) => v.verdict.kind === 'fail',
  );

  let failed = 0;
  for (const { id, claimGeneration, dbNow, updatedAt } of stale) {
    // Avant l'écriture, la règle des faucheurs (`takeLostRun`) : la ligne
    // prise (un job prenable est pris, comme un worker le prendrait) et ses
    // processus morts, ou rien — un worker l'a pris entre-temps.
    if (
      (await takeLostRun(db, { id, status: 'pending', claimGeneration }, presence.instanceId)) ===
      null
    ) {
      continue;
    }
    const line = sweptJobStopLine({
      status: 'pending',
      idleMs: dbNow.getTime() - (updatedAt?.getTime() ?? dbNow.getTime()),
    });
    const landed = await failJob(
      db,
      id,
      'stale_pending_abandoned',
      undefined,
      undefined,
      line,
      undefined,
      {
        runnerLines: [line],
      },
    );
    if (landed) {
      failed += 1;
      // Le FAIT, porté par le job (#1204) : jamais pris, demandé il y a trop
      // longtemps — sur l'horloge de la base.
      await db
        .update(agentJobs)
        .set({
          sweeperObserved: {
            outcome: 'failed',
            reason: 'never_claimed',
            holder: null,
            holderState: null,
            holderLastSeenAt: null,
            holderStoppedAt: null,
            observedBy: presence.instanceId,
            observedAt: dbNow.toISOString(),
          },
        })
        .where(eq(agentJobs.id, id));
    }
  }
  return failed;
}

// ─── approval TTL ───────────────────────────────────────────────────────────────

/**
 * Expire pending approvals whose TTL (`expires_at`, default now + 1h) has
 * passed, then put the job that waited on them back to work (issue #349).
 *
 * The deadline used to be written at creation and never applied, so an
 * unanswered request stayed `pending` forever: the card kept saying "expires
 * <a past date>", the rail kept counting it, the Approvals page kept listing
 * it under Pending. One UPDATE ... RETURNING marks the whole batch, which is
 * what makes the sweep idempotent — a second tick, or a second runner, finds
 * nothing left `pending` past its deadline.
 *
 * What the job does next is a RESUME, not a failure. It comes back exactly the
 * way it comes back from a rejection (`approvals/resume.ts`, shared with the
 * human path), and the model reads an error on its gated tool call saying the
 * request expired unanswered. The agent then adapts: it asks again, takes
 * another route, or reports that it could not proceed. Failing the job here
 * instead would end the run on a timer, with a canned notice, for a request
 * the person may simply not have seen yet.
 *
 * @returns count of approval requests expired by this sweep
 */
export async function expireStaleApprovals(
  db: AnyDrizzleDb,
  runnerEnv?: RunnerEnv,
): Promise<number> {
  const now = new Date();
  // PORTE (b) : expirées sous la garde `pending`, et annoncées (#944) — une
  // carte ouverte ailleurs se ferme.
  const expired = await expirePendingRequests(db, {
    where: lt(approvalRequests.expiresAt, now),
    resolvedBy: 'system:ttl_expired',
    now,
  });

  // Une demande par job suffit à le réveiller : le job relit TOUTES ses lignes
  // ouvertes à la reprise (execute.ts, 11.7). Deux demandes échues sur le même
  // job ne le reprennent donc qu'une fois.
  //
  // Une ÉLICITATION échue (0145) ne réveille rien : le job n'a jamais été
  // suspendu pour elle — son run la sonde lui-même et rend `cancel` au serveur
  // MCP. La reprendre ferait repartir un job suspendu pour une AUTRE raison
  // sur une décision qui n'est pas la sienne.
  const toResume = expired.filter((r) => (CALL_GATE_KINDS as readonly string[]).includes(r.kind));
  for (const jobId of new Set(toResume.map((r) => r.jobId))) {
    // A job that already moved on (approved elsewhere, cancelled, completed)
    // is left alone: the conditional flip inside the shared resume is what
    // decides, and it reports rather than forcing.
    await resumeJobAfterApprovalResolution(db, jobId, runnerEnv);
  }

  return expired.length;
}
