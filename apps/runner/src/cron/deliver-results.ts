// cron/deliver-results.ts — deliverCompletedRoots
// For each root_job_id whose tasks are all terminal (done/failed/cancelled),
// compile task results and mark the root job completed.
//
// Idempotency: completedAt acts as the done flag — if it's already set,
// the root is skipped. The conditional UPDATE prevents double-processing
// under concurrent ticks.

import { and, eq, isNotNull, isNull, notInArray, agents } from '@nodal-agents/db';
import { agentJobs, agentTasks } from '@nodal-agents/db';
import type { AnyDrizzleDb } from '@nodal-agents/db';
import { checkRootJobComplete } from '@nodal-agents/orchestration';
import type { JobId } from '@nodal-agents/orchestration';
import { sendTelegramMessage } from '@nodal-agents/delivery';
import { resolveAgentLlmClient } from '../job/resolve-llm.ts';
import { maybeResumeParent } from '../job/execute.ts';
import type { ExecuteJobResult } from '../job/execute.ts';

// Statuses a root job can be in that mean "this job is DONE, do not touch it
// again" — regardless of completedAt. A user-cancelled root (C-2, audit#2)
// never gets completedAt set by cancelJobAction (apps/web/src/lib/actions.ts),
// so completedAt IS NULL alone is not a safe "still needs delivery" signal:
// if even one of its tasks had already reached 'done' before the cancel, the
// rootStatus derivation below would compute 'completed' and the claim UPDATE
// would resurrect a cancelled job (overwrite status + set completedAt + fire
// delivery). Excluding these statuses everywhere completedAt IS NULL is
// checked closes that hole.
const TERMINAL_ROOT_STATUSES: string[] = ['cancelled', 'completed', 'failed'];

// ─── findUndeliveredRootJobIds ─────────────────────────────────────────────────

/**
 * Distinct root_job_ids that still need delivery: at least one task, AND the
 * root job itself not yet delivered (completedAt IS NULL).
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
 * added by migration 0054 (audit #2, DB-3) — back this exact query: the FROM
 * agent_tasks side now hits the root_job_id index instead of a full scan, and
 * the join's `completed_at IS NULL` filter hits the partial index (kept small
 * since completed roots vastly outnumber open ones).
 *
 * Also excludes roots already in a TERMINAL_ROOT_STATUS (C-2, audit#2): a
 * user-cancelled root has completedAt IS NULL forever (cancelJobAction never
 * sets it), so without this filter a cancelled root with a leftover 'done'
 * task keeps getting scanned back in on every tick — see deliverCompletedRoots
 * below for the resurrection this would otherwise cause.
 *
 * Exported (not just inlined in deliverCompletedRoots) so the bound-scan
 * behavior itself is directly testable, independent of the per-row loop's own
 * completedAt guard below.
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
        notInArray(agentJobs.status, TERMINAL_ROOT_STATUSES),
      ),
    );
  return rows.map((r) => r.rootJobId!);
}

// ─── deliverCompletedRoots ────────────────────────────────────────────────────

/**
 * Bug from legacy (inject_delegation.wrong_status): task results were silently
 * lost because delivery was only triggered on the parent job completing, but
 * planner tasks run async AFTER the parent job completes. This function finds
 * all root jobs whose tasks have all finished and compiles + marks the result.
 *
 * Idempotency: each root job is marked at most once. The root job's
 * `completedAt` column is used as the done flag — if it's already
 * set, we skip. The update is conditional (`WHERE completed_at IS NULL`) to
 * prevent double-processing under concurrent ticks.
 *
 * @returns count of root jobs completed
 */
export async function deliverCompletedRoots(db: AnyDrizzleDb): Promise<number> {
  const undeliveredRootJobIds = await findUndeliveredRootJobIds(db);

  if (undeliveredRootJobIds.length === 0) return 0;

  let delivered = 0;

  for (const rootJobId of undeliveredRootJobIds) {
    // Check if root job already delivered (completedAt is set) — a
    // race-safety net for concurrent ticks; findUndeliveredRootJobIds already
    // excluded delivered roots from the candidate set above.
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
      })
      .from(agentJobs)
      .where(eq(agentJobs.id, rootJobId))
      .limit(1);

    const rootJob = rootJobRows[0];
    if (!rootJob) continue; // root job doesn't exist (orphaned tasks)
    if (rootJob.completedAt !== null) continue; // already delivered
    // C-2 (audit#2): defense in depth — a cancelled/completed/failed root
    // never gets completedAt set by cancelJobAction (web actions.ts), so the
    // completedAt-only guard above lets it through. findUndeliveredRootJobIds
    // already excludes these statuses at the scan level, but re-check here in
    // case this row's status changed between the scan and this load (e.g. a
    // user cancel racing the cron tick): never resurrect a terminal root.
    if (TERMINAL_ROOT_STATUSES.includes(rootJob.status ?? '')) continue;

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
    // only honestly 'completed' when at least one task succeeded. Before this
    // fix the UPDATE below always forced 'completed', even when every task in
    // the fan-out had failed (audit finding #8, 2026-07): the body correctly
    // tagged `[blocked]`/`[cancelled]` sections, but the STATUS lied, and any
    // logic/dashboard filtering on status='completed' was fooled.
    //
    // agent_tasks has no 'failed' status — the check constraint is
    // todo/in_progress/done/cancelled/blocked (packages/db/src/schema/tasks.ts)
    // — so 'blocked' is the failure-equivalent terminal state and 'cancelled'
    // is the voluntary-abort one. agent_jobs.status (packages/db/src/schema/
    // jobs.ts) has no "partial" value between 'completed' and 'failed', so a
    // MIX of done + failed/cancelled tasks is still reported 'completed': the
    // compiled result body already tags each non-done section, which is the
    // honest signal for a partial run. Priority when nothing succeeded:
    //   1. any 'done'                          → 'completed' (partial run)
    //   2. no 'done', at least one 'blocked'    → 'failed'    (something broke)
    //   3. no 'done', no 'blocked' (all 'cancelled') → 'cancelled' (nothing broke,
    //      the fan-out was voluntarily aborted — reporting 'failed' here would
    //      itself be dishonest, per invariant #4)
    const doneCount = taskRows.filter((t) => t.status === 'done').length;
    const blockedCount = taskRows.filter((t) => t.status === 'blocked').length;
    const rootStatus: 'completed' | 'failed' | 'cancelled' =
      doneCount > 0 ? 'completed' : blockedCount > 0 ? 'failed' : 'cancelled';
    const rootError = rootStatus === 'failed' ? `all_tasks_failed (${taskRows.length})` : null;

    // Atomic claim: only deliver if root job completedAt is still NULL AND
    // the root hasn't been raced into a terminal status (cancelled by the
    // user, or completed/failed by another tick) since we loaded it above —
    // C-2 (audit#2): without the status guard, a concurrent cancel landing
    // between the load and this UPDATE would still get overwritten back to
    // 'completed'. This prevents double-processing AND resurrection under
    // concurrent ticks (invariant from spec).
    const claimed = await db
      .update(agentJobs)
      .set({
        status: rootStatus,
        result: compiledResult,
        error: rootError,
        completedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(agentJobs.id, rootJobId),
          isNull(agentJobs.completedAt), // gate: only one tick wins
          notInArray(agentJobs.status, TERMINAL_ROOT_STATUSES), // gate: never resurrect a cancelled/terminal root
        ),
      )
      .returning({ id: agentJobs.id });

    if (claimed.length === 0) {
      // Another concurrent tick won the race, OR the root was cancelled
      // between our load and this UPDATE (C-2 guard) — skip delivery either way
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
      // This root was already delivered above (claim succeeded) — only the
      // parent resume failed (e.g. malformed pending_delegation). Don't let
      // that abort the whole tick: the other roots still need delivering.
      console.warn(`[deliverCompletedRoots] maybeResumeParent failed for ${rootJobId}:`, err);
    }

    // Actually DELIVER to the originating channel. A root job carries a chatId
    // ONLY when there was delivery intent (a Telegram-originated request, or a
    // cron with notify_on_success). Invariant (Quentin): a request that started
    // in a channel ALWAYS returns to it with a SHORT summary — owned by the root,
    // never a dedicated task. So we synthesize a concise summary of the run via
    // the root agent's own model and send THAT (not the raw 15K concatenation,
    // which Telegram rejects as "message too long"). No chatId = no send
    // (preserves the anti-phantom-send guarantee).
    if (rootJob.chatId && rootJob.agentId && compiledResult.trim()) {
      try {
        const [ag] = await db
          .select({
            botToken: agents.telegramBotToken,
            llmKeyId: agents.llmKeyId,
            fallbackChain: agents.fallbackChain,
            model: agents.model,
          })
          .from(agents)
          .where(eq(agents.id, rootJob.agentId))
          .limit(1);
        if (ag?.botToken) {
          const summary = await synthesizeForChannel(db, ag, rootJob.task ?? '', compiledResult);
          await sendTelegramMessage({
            chatId: rootJob.chatId,
            text: summary,
            botToken: ag.botToken,
          });
        }
      } catch (err) {
        // Delivery failure must not break completion — the result is persisted on
        // the root job either way; log and move on.
        console.error(`[deliverCompletedRoots] telegram send failed for ${rootJobId}:`, err);
      }
    }

    delivered++;
  }

  return delivered;
}

// ─── synthesizeForChannel ─────────────────────────────────────────────────────

/**
 * Produce the SHORT channel return for a finished run. Runs one LLM call with
 * the root agent's own model to summarize the compiled task results into a few
 * lines suitable for a chat message — never the raw multi-thousand-char dump.
 * Falls back to the compiled text if no LLM is available or the call fails
 * (sendTelegramMessage will chunk it so it still gets through). This is the
 * root's channel return — by design it is NOT a delegated task.
 */
async function synthesizeForChannel(
  db: AnyDrizzleDb,
  agent: {
    llmKeyId: string | null;
    fallbackChain: unknown;
    model: string | null;
  },
  originalRequest: string,
  compiledResult: string,
): Promise<string> {
  try {
    const resolved = await resolveAgentLlmClient(db, {
      llmKeyId: agent.llmKeyId,
      fallbackChain: (agent.fallbackChain ?? null) as
        | readonly { keyId: string; model: string }[]
        | null,
      model: agent.model ?? '',
    });
    if (!resolved.ok) return compiledResult;
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
    return text.length > 0 ? text : compiledResult;
  } catch (err) {
    console.error('[deliverCompletedRoots] synthesis failed, sending compiled result:', err);
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
