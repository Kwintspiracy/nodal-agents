// job/call-outcomes.ts — the calls a job leaves not done, read from its rows (#1184).
//
// THE ONE READER, for the runner, of what became of a job's tool calls. The
// seam writes each call's outcome and target once (`tool_calls.outcome`,
// `tool_calls.target`, packages/tools/src/execute.ts); the verdict over them
// is `unresolvedCalls` (@nodal-agents/shared), the same function the web and
// the bench read. Here it is fed the job's rows, whatever run wrote them: a
// run resumed after an approval, a delegation or a restart reads the same
// rows, and nothing is remembered in memory.
//
// Two readers in the runner: the completion gate (`finalizeJobSuccess`), for
// which an unresolved call leaves the job's work not done, and the loop's
// bounded reminder to redo a failed delivery before the end.

import { and, eq, toolCalls } from '@nodal-agents/db';
import type { AnyDrizzleDb } from '@nodal-agents/db';
import { unresolvedCalls, type OutcomeRow, type UnresolvedCall } from '@nodal-agents/shared';

/** The rows of a job, as the verdict reads them. */
export async function callOutcomeRows(db: AnyDrizzleDb, jobId: string): Promise<OutcomeRow[]> {
  return db
    .select({
      seq: toolCalls.seq,
      toolName: toolCalls.toolName,
      toolCallId: toolCalls.toolCallId,
      outcome: toolCalls.outcome,
      target: toolCalls.target,
      riskLevel: toolCalls.riskLevel,
      readOnlyHint: toolCalls.readOnlyHint,
      executionStarted: toolCalls.executionStarted,
    })
    .from(toolCalls)
    .where(and(eq(toolCalls.jobId, jobId)));
}

/**
 * The calls of `jobId` that leave its work not done. `deliveredByHarness`: the
 * key of the chat the harness itself sends the job's answer to when it
 * completes (job/answer-delivery.ts): a text send there that failed or is
 * unconfirmed is made good by that delivery, which sends the answer, again
 * when unconfirmed (#1215).
 */
export async function jobUnresolvedCalls(
  db: AnyDrizzleDb,
  jobId: string,
  deliveredByHarness: string | null = null,
): Promise<UnresolvedCall[]> {
  return unresolvedCalls(await callOutcomeRows(db, jobId), {
    resolvedTargets: deliveredByHarness === null ? [] : [deliveredByHarness],
  });
}
