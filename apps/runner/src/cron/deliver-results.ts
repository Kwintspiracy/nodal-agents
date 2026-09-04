// cron/deliver-results.ts — deliverCompletedRoots
// For each root_job_id whose tasks are all terminal (done/failed/cancelled),
// compile task results, decide the root's terminal status, and hand the
// channel return to the delivery outbox.
//
// ─── Plan « Vérifier & Corriger », T12 ────────────────────────────────────────
//
// Le bug fermé ici est EXISTANT : ce fichier écrivait `status` + `completed_at`
// puis envoyait au canal APRÈS, sans qu'aucune colonne ne trace l'envoi. Un
// crash entre les deux laissait un root terminal jamais relivré — la garde de
// reprise (`completed_at IS NULL`) l'excluait à jamais.
//
// Le nouvel ordre, par root :
//   1. RÉCLAMATION par le marqueur `finalizing_at` (UPDATE … RETURNING) — un
//      seul tick travaille sur un root, sans écrire son statut ;
//   2. HORS transaction : la cible de livraison (resolveDeliveryTarget) et la
//      synthèse courte pour le canal (un appel LLM — jamais dans une
//      transaction, jamais au drain) : le PAYLOAD EST FIGÉ ici, une fois ;
//   3. la décision terminale : `completed` ⇒ la primitive `finalizeJobSuccess`
//      (qui commet la ligne `job_deliveries` en `prepared` AVEC le statut) ;
//      `failed` ⇒ `failJob` ; `cancelled` ⇒ `cancelRootJob`. Chacune lève le
//      marqueur ;
//   4. `maybeResumeParent`, puis `drainDeliveries` pour ce root — l'envoi,
//      réclamable, borné, reprenable. Un crash après 3 ne perd plus rien : la
//      seconde population du tick reprend la ligne `prepared`.
//
// Un marqueur `finalizing_at` plus vieux que FINALIZING_STALE_MS sans
// `completed_at` est relâché en début de phase : le tick qui l'avait posé est
// mort avant sa décision terminale.
//
// Idempotency: completedAt acts as the delivered flag for the SCAN; the claim
// is the marker. A user-cancelled root (C-2, audit#2) never gets completedAt
// set by cancelJobAction, so the terminal statuses are excluded everywhere
// completedAt IS NULL is checked — never resurrect a terminal root.

import { and, eq, isNotNull, isNull, lt, notInArray, agents } from '@nodal-agents/db';
import { agentJobs, agentTasks } from '@nodal-agents/db';
import type { AnyDrizzleDb } from '@nodal-agents/db';
import { checkRootJobComplete } from '@nodal-agents/orchestration';
import type { JobId } from '@nodal-agents/orchestration';
import type { ChannelKind } from '@nodal-agents/delivery';
import { resolveAgentLlmClient } from '../job/resolve-llm.ts';
import { makeLlmCallSink } from '../llm/call-sink.ts';
import { maybeResumeParent } from '../job/execute.ts';
import type { ExecuteJobResult } from '../job/execute.ts';
import { TERMINAL_STATUSES, cancelRootJob, failJob } from '../job/state.ts';
import { finalizeJobSuccess, FINALIZING_STALE_MS } from '../job/finalize.ts';
import { drainDeliveries, prepareDelivery } from '../delivery/outbox.ts';
import { isDeliveryRefusal, resolveDeliveryTarget } from '../delivery/resolve-delivery-target.ts';

/** Le MÊME seuil que la primitive (elle reprend un marqueur périmé de la même façon). */
export { FINALIZING_STALE_MS };

/** Codes journalisés (inv. #2 : des codes et des données, jamais une phrase). */
export const DELIVERY_SYNTHESIS_FAILED = 'DELIVERY_SYNTHESIS_FAILED';
export const DELIVERY_TARGET_REFUSED = 'DELIVERY_TARGET_REFUSED';
export const FINALIZING_MARKER_RELEASED = 'FINALIZING_MARKER_RELEASED';
export const DELIVERY_DRAIN_FAILED = 'DELIVERY_DRAIN_FAILED';

// ─── findUndeliveredRootJobIds ─────────────────────────────────────────────────

/**
 * Distinct root_job_ids that still need delivery: at least one task, AND the
 * root job itself not yet delivered (completedAt IS NULL), AND not currently
 * claimed by a tick (finalizingAt IS NULL — T12).
 *
 * Bounding the scan here — instead of pulling every root_job_id agent_tasks
 * has ever seen and discarding the already-delivered ones one row at a time
 * in deliverCompletedRoots' loop — is the fix for audit finding #27: retention
 * doesn't purge agent_tasks, so the old unfiltered query re-scanned the ENTIRE
 * task history every tick (120s) and re-issued a per-row SELECT for every root
 * ever delivered, not just the ones still pending. The join against
 * agent_jobs.completed_at excludes delivered roots up front, so the caller's
 * loop only ever iterates roots that genuinely still need work.
 *
 * `idx_agent_tasks_root_job_id` (agent_tasks.root_job_id) and
 * `idx_agent_jobs_completed_at_null` (agent_jobs.completed_at WHERE NULL) —
 * added by migration 0054 (audit #2, DB-3) — back this exact query.
 *
 * Also excludes roots already in a TERMINAL status (C-2, audit#2): a
 * user-cancelled root has completedAt IS NULL forever (cancelJobAction never
 * sets it), so without this filter a cancelled root with a leftover 'done'
 * task keeps getting scanned back in on every tick.
 *
 * Exported (not just inlined in deliverCompletedRoots) so the bound-scan
 * behavior itself is directly testable, independent of the per-row loop's own
 * guards below.
 */
export async function findUndeliveredRootJobIds(db: AnyDrizzleDb): Promise<string[]> {
  const rows = await db
    .selectDistinct({ rootJobId: agentTasks.rootJobId })
    .from(agentTasks)
    .innerJoin(agentJobs, eq(agentJobs.id, agentTasks.rootJobId))
    .where(
      and(
        isNotNull(agentTasks.rootJobId),
        isNull(agentJobs.completedAt),
        isNull(agentJobs.finalizingAt),
        notInArray(agentJobs.status, TERMINAL_STATUSES),
      ),
    );
  return rows.map((r) => r.rootJobId!);
}

// ─── releaseStaleFinalizingMarkers ────────────────────────────────────────────

/**
 * Relâche les marqueurs `finalizing_at` orphelins : posés il y a plus de
 * FINALIZING_STALE_MS, sans décision terminale depuis. Le root redevient
 * candidat au scan du même tick.
 *
 * @returns nombre de marqueurs relâchés
 */
export async function releaseStaleFinalizingMarkers(
  db: AnyDrizzleDb,
  now: Date = new Date(),
): Promise<number> {
  const cutoff = new Date(now.getTime() - FINALIZING_STALE_MS);
  const rows = await db
    .update(agentJobs)
    .set({ finalizingAt: null, updatedAt: now })
    .where(
      and(
        isNotNull(agentJobs.finalizingAt),
        lt(agentJobs.finalizingAt, cutoff),
        isNull(agentJobs.completedAt),
      ),
    )
    .returning({ id: agentJobs.id });
  for (const row of rows) {
    console.warn(`[deliverCompletedRoots] ${FINALIZING_MARKER_RELEASED} job=${row.id}`);
  }
  return rows.length;
}

// ─── deliverCompletedRoots ────────────────────────────────────────────────────

/**
 * Bug from legacy (inject_delegation.wrong_status): task results were silently
 * lost because delivery was only triggered on the parent job completing, but
 * planner tasks run async AFTER the parent job completes. This function finds
 * all root jobs whose tasks have all finished and compiles + finalizes the
 * result.
 *
 * @returns count of root jobs finalized by THIS call
 */
export async function deliverCompletedRoots(db: AnyDrizzleDb): Promise<number> {
  await releaseStaleFinalizingMarkers(db);

  const undeliveredRootJobIds = await findUndeliveredRootJobIds(db);

  if (undeliveredRootJobIds.length === 0) return 0;

  let delivered = 0;

  for (const rootJobId of undeliveredRootJobIds) {
    // Re-load the root: a race-safety net for concurrent ticks —
    // findUndeliveredRootJobIds already excluded delivered/claimed roots from
    // the candidate set above.
    const rootJobRows = await db
      .select({
        id: agentJobs.id,
        status: agentJobs.status,
        completedAt: agentJobs.completedAt,
        channel: agentJobs.channel,
        chatId: agentJobs.chatId,
        agentId: agentJobs.agentId,
        entityId: agentJobs.entityId,
        task: agentJobs.task,
        triggerContext: agentJobs.triggerContext,
      })
      .from(agentJobs)
      .where(eq(agentJobs.id, rootJobId))
      .limit(1);

    const rootJob = rootJobRows[0];
    if (!rootJob) continue; // root job doesn't exist (orphaned tasks)
    if (rootJob.completedAt !== null) continue; // already delivered
    // C-2 (audit#2): defense in depth — never resurrect a terminal root.
    if (TERMINAL_STATUSES.includes(rootJob.status as (typeof TERMINAL_STATUSES)[number])) continue;

    // Check if all tasks for this root are in terminal states
    const complete = await checkRootJobComplete(rootJobId as JobId, db);
    if (!complete) continue;

    // Load all task results to compile
    const taskRows = await db
      .select({
        id: agentTasks.id,
        title: agentTasks.title,
        status: agentTasks.status,
        result: agentTasks.result,
      })
      .from(agentTasks)
      .where(eq(agentTasks.rootJobId, rootJobId));

    const compiledResult = compileTaskResults(taskRows);

    // Derive the root's status from what the tasks actually did — a root is
    // only honestly 'completed' when at least one task succeeded (audit
    // finding #8, 2026-07). agent_tasks has no 'failed' status — 'blocked' is
    // the failure-equivalent terminal state and 'cancelled' the voluntary
    // abort. A MIX of done + failed/cancelled tasks is still 'completed': the
    // compiled body tags each non-done section. Priority when nothing
    // succeeded: any 'blocked' → 'failed'; all 'cancelled' → 'cancelled'
    // (reporting 'failed' there would itself be dishonest, invariant #4).
    const doneCount = taskRows.filter((t) => t.status === 'done').length;
    const blockedCount = taskRows.filter((t) => t.status === 'blocked').length;
    const rootStatus: 'completed' | 'failed' | 'cancelled' =
      doneCount > 0 ? 'completed' : blockedCount > 0 ? 'failed' : 'cancelled';
    const rootError = rootStatus === 'failed' ? `all_tasks_failed (${taskRows.length})` : null;

    // ── 1. Réclamation : le marqueur, PAS le statut ────────────────────────
    // Only one tick wins; a concurrent cancel landing between the load and
    // this UPDATE is refused by the status gate (C-2) — never resurrect.
    const now = new Date();
    const claimed = await db
      .update(agentJobs)
      .set({ finalizingAt: now, updatedAt: now })
      .where(
        and(
          eq(agentJobs.id, rootJobId),
          isNull(agentJobs.completedAt),
          isNull(agentJobs.finalizingAt),
          notInArray(agentJobs.status, TERMINAL_STATUSES),
        ),
      )
      .returning({ id: agentJobs.id });

    if (claimed.length === 0) {
      // Another concurrent tick won the claim, OR the root was cancelled
      // between our load and this UPDATE (C-2 guard) — skip either way.
      continue;
    }

    // ── 2. Hors transaction : la cible et le payload FIGÉ ─────────────────
    // A root job carries a chatId ONLY when there was delivery intent (a
    // Telegram-originated request, or a cron with notify_on_success).
    // Invariant (Quentin): a request that started in a channel ALWAYS returns
    // to it with a SHORT summary — owned by the root, never a dedicated task.
    // The summary is synthesized ONCE, here, and frozen in the outbox row: a
    // retried send never re-runs the LLM. The allowlist and the credentials
    // are re-checked at the drain, never here.
    let delivery: { channel: ChannelKind; chatId: string; payload: string } | undefined;
    if (rootStatus === 'completed' && rootJob.chatId && compiledResult.trim()) {
      const target = await resolveDeliveryTarget(db, {
        chatId: rootJob.chatId,
        agentId: rootJob.agentId,
        channel: rootJob.channel,
        triggerContext: rootJob.triggerContext,
      });
      if (isDeliveryRefusal(target)) {
        console.error(
          `[deliverCompletedRoots] ${DELIVERY_TARGET_REFUSED} job=${rootJobId} reason=${target.refused}`,
        );
      } else if (rootJob.agentId) {
        const payload = await synthesizePayload(
          db,
          rootJob.agentId,
          rootJob.task ?? '',
          compiledResult,
        );
        delivery = { channel: target.channel, chatId: target.chatId, payload };
      }
    }

    // ── 3. La décision terminale — lève le marqueur ───────────────────────
    let landed: boolean;
    if (rootStatus === 'completed') {
      const outcome = await finalizeJobSuccess(
        db,
        {
          jobId: rootJobId,
          result: compiledResult,
          toolsUsed: [],
          delivery,
          // Le marqueur posé à l'étape 1 est le NÔTRE : la primitive l'accepte.
          claim: { finalizingAt: now },
        },
        {
          prepareDelivery: async (tx, input) => {
            await prepareDelivery(tx, {
              jobId: input.jobId,
              channel: input.channel as ChannelKind,
              chatId: input.chatId,
              payload: input.payload,
            });
          },
        },
      );
      landed = outcome.kind !== 'already_terminal';
    } else if (rootStatus === 'failed') {
      landed = await failJob(
        db,
        rootJobId,
        rootError ?? 'all_tasks_failed',
        undefined,
        undefined,
        compiledResult,
      );
    } else {
      landed = await cancelRootJob(db, rootJobId, compiledResult);
    }
    if (!landed) {
      // The root became terminal under our marker (a user cancel racing the
      // tick). Nothing to deliver, nothing to resume — and the marker is gone
      // with the terminal write.
      continue;
    }

    // This root job may itself be a delegated child of another job stuck in
    // `awaiting_delegation` (nested planner delegation — a child orchestrator
    // that fanned out via create_task, finalized here by the cron rather than
    // by executeJob's own wrapper). maybeResumeParent no-ops when there is no
    // such parent; when there is, it injects this outcome as the parent's
    // tool_result and flips it back to `pending` so it resumes instead of
    // stalling forever (audit finding OR-5).
    try {
      const resumeOutcome: Extract<
        ExecuteJobResult,
        { status: 'completed' | 'failed' | 'cancelled' }
      > =
        rootStatus === 'completed'
          ? { status: 'completed', result: compiledResult }
          : rootStatus === 'failed'
            ? { status: 'failed', error: rootError ?? 'all_tasks_failed', result: compiledResult }
            : { status: 'cancelled' };
      await maybeResumeParent(rootJobId as JobId, resumeOutcome, { db });
    } catch (err) {
      // This root was already finalized above — only the parent resume failed
      // (e.g. malformed pending_delegation). Don't let that abort the whole
      // tick: the other roots still need finalizing.
      console.warn(`[deliverCompletedRoots] maybeResumeParent failed for ${rootJobId}:`, err);
    }

    // ── 4. Le drain immédiat — l'envoi, hors de toute transaction ─────────
    // A failure here does not undo a committed root: it is said, and the
    // `prepared` row is picked up by the tick's second population.
    try {
      await drainDeliveries(db, { jobId: rootJobId });
    } catch (err) {
      console.error(
        `[deliverCompletedRoots] ${DELIVERY_DRAIN_FAILED} job=${rootJobId} error=${err instanceof Error ? err.message : String(err)}`,
      );
    }

    delivered++;
  }

  return delivered;
}

// ─── synthesizePayload ────────────────────────────────────────────────────────

/**
 * Le texte qui part au canal : la synthèse courte quand le modèle du root la
 * rend, sinon le résultat compilé — et dans ce cas le repli est DIT
 * (`DELIVERY_SYNTHESIS_FAILED`), jamais silencieux.
 */
async function synthesizePayload(
  db: AnyDrizzleDb,
  agentId: string,
  originalRequest: string,
  compiledResult: string,
): Promise<string> {
  const [ag] = await db
    .select({
      llmKeyId: agents.llmKeyId,
      fallbackChain: agents.fallbackChain,
      model: agents.model,
      reasoningEffort: agents.reasoningEffort,
    })
    .from(agents)
    .where(eq(agents.id, agentId))
    .limit(1);
  if (!ag) {
    console.error(
      `[deliverCompletedRoots] ${DELIVERY_SYNTHESIS_FAILED} agent=${agentId} cause=no_agent`,
    );
    return compiledResult;
  }
  return synthesizeForChannel(db, ag, originalRequest, compiledResult);
}

// ─── synthesizeForChannel ─────────────────────────────────────────────────────

/**
 * Produce the SHORT channel return for a finished run. Runs one LLM call with
 * the root agent's own model to summarize the compiled task results into a few
 * lines suitable for a chat message — never the raw multi-thousand-char dump.
 * Falls back to the compiled text if no LLM is available or the call fails,
 * and SAYS so by code (the adapter will chunk it so it still gets through).
 * This is the root's channel return — by design it is NOT a delegated task.
 */
async function synthesizeForChannel(
  db: AnyDrizzleDb,
  agent: {
    llmKeyId: string | null;
    fallbackChain: unknown;
    model: string | null;
    reasoningEffort?: string | null;
  },
  originalRequest: string,
  compiledResult: string,
): Promise<string> {
  try {
    const resolved = await resolveAgentLlmClient(
      db,
      {
        llmKeyId: agent.llmKeyId,
        fallbackChain: (agent.fallbackChain ?? null) as
          | readonly { keyId: string; model: string; reasoningEffort?: string }[]
          | null,
        model: agent.model ?? '',
        reasoningEffort: agent.reasoningEffort ?? null,
      },
      undefined,
      // étape D: the delivery-synthesis call was an invisible LLM consumer.
      makeLlmCallSink(db, { source: 'cron' }),
    );
    if (!resolved.ok) {
      console.error(`[deliverCompletedRoots] ${DELIVERY_SYNTHESIS_FAILED} cause=llm_unavailable`);
      return compiledResult;
    }
    const result = await resolved.client.generateText({
      system:
        'You write the SHORT chat reply that closes out a multi-agent run for the user. ' +
        'Summarize the results below into a few clear lines, in the user’s language. ' +
        'This is a chat message, not a report — be concise (a handful of lines, key outcomes per ' +
        'agent/task). The full detail is already saved elsewhere (dashboard/files/email), so do ' +
        'NOT reproduce it. Plain text, minimal markdown.',
      prompt: `The user asked:\n${originalRequest}\n\nCompiled results from the run:\n${compiledResult}`,
    });
    const text = (result.text ?? '').trim();
    if (text.length === 0) {
      console.error(`[deliverCompletedRoots] ${DELIVERY_SYNTHESIS_FAILED} cause=empty_text`);
      return compiledResult;
    }
    return text;
  } catch (err) {
    console.error(
      `[deliverCompletedRoots] ${DELIVERY_SYNTHESIS_FAILED} cause=${err instanceof Error ? err.message : String(err)}`,
    );
    return compiledResult;
  }
}

// ─── compileTaskResults ───────────────────────────────────────────────────────

/**
 * Concatenate task results with their titles as section headers.
 * Done tasks show their result; failed/blocked tasks show the error.
 */
function compileTaskResults(
  tasks: Array<{
    id: string;
    title: string;
    status: string;
    result: string | null;
  }>,
): string {
  if (tasks.length === 0) return '';

  return tasks
    .map((t) => {
      const statusTag = t.status === 'done' ? '' : ` [${t.status}]`;
      const body = t.result?.trim() ?? '';
      return `## ${t.title}${statusTag}\n${body || '(no result)'}`;
    })
    .join('\n\n---\n\n');
}
