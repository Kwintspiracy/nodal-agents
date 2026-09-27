// router/failed-delegation.ts — what an orchestrator may do after a delegation
// fails, in ONE place: the resume payload that tells it (resume.ts) and the
// runner gate that refuses a retry (apps/runner/src/job/execute.ts) read the
// same state and the same cap, so the words and the gate cannot disagree.
//
// Issue #510 (run 8dfe4684, 2026-09-25). Montage failed on one precise point.
// The gate refused any second call to Montage after that first failure, and the
// payload said "DO NOT retry the same specialist … delegate to a DIFFERENT
// specialist whose skills match". So the orchestrator did the only thing it was
// allowed to: it spread the render to a code team chosen by the look of the
// task, which had neither the folder nor a shell. The agent that had both was
// never asked again.
//
// The order now: the same agent once more, on the precise blocking point, when
// its roster entry shows it has what that needs; another agent ONLY when its
// roster entry shows what the task needs (folders, shell commands, connectors —
// see the team block, #506); otherwise the truth to the user. A second failure
// of the same agent in a row blocks it: the anti-loop guard (invariant #8)
// stays, one step later.

import { and, desc, eq } from '@nodal-agents/db';
import { agents, agentJobs } from '@nodal-agents/db';
import { filesTheChildWrote, readFilesWrittenBy } from './delegated-files';
import type { AnyDrizzleDb, JobId } from '../types';

/** Consecutive failures of the same agent after which a retry is refused. */
export const SAME_AGENT_FAILURE_CAP = 2;

export interface FailedDelegationState {
  /** `agent_jobs.last_failed_delegation_slug`. */
  slug: string | null;
  /** `agent_jobs.last_failed_delegation_streak`. */
  streak: number;
}

/**
 * The state after one delegation returns. A failure of the same slug extends
 * the streak, a failure of another slug restarts it at 1, a success clears it.
 */
export function nextFailedDelegationState(
  prev: FailedDelegationState,
  failedSlug: string | null,
): FailedDelegationState {
  if (failedSlug === null) return { slug: null, streak: 0 };
  const streak = prev.slug === failedSlug ? prev.streak + 1 : 1;
  return { slug: failedSlug, streak };
}

/** True when delegating to `childSlug` now must be refused. */
export function isSameAgentRetryBlocked(state: FailedDelegationState, childSlug: string): boolean {
  return state.slug === childSlug && state.streak >= SAME_AGENT_FAILURE_CAP;
}

/**
 * What a stopped child left behind (#491): files it wrote that are still there.
 * They are work to build on, not to redo, and the guidance says so first.
 */
export interface FailedDelegationContext {
  childLeftFiles?: boolean;
}

const CHILD_FILES_PARAGRAPH =
  'This delegation stopped before it finished, but it left files. Those in files_written with "state": "written_by_child_unchanged" are exactly what the specialist wrote. Those with "state": "written_by_child_unverified" were written by the specialist, but their content has no fingerprint, so it cannot be proven they did not change since: read them before relying on them. DO NOT redo that work and DO NOT delegate it again: check those files and build on them. Any other state means that file is NOT the specialist\'s finished output (absent, changed since, never written by it, or unknown): that part is not done. For anything these files do not cover:';

/**
 * The instructions appended to a failed delegation's tool_result, and returned
 * by the gate that refuses a retry (execute.ts, `delegation_retry_blocked`):
 * one text, one rule. LLM-channel text only; it never reaches the user
 * (invariant #2).
 */
export function failedDelegationGuidance(
  state: FailedDelegationState,
  ctx: FailedDelegationContext = {},
): string {
  const tool = `assign_${(state.slug ?? '').replace(/-/g, '_')}`;
  const noPromise =
    'DO NOT tell the user the work is in progress, launched, or coming later: it is not, ' +
    'and nothing else will arrive.';
  const elsewhere =
    'hand the work to a DIFFERENT agent ONLY if its entry in your team roster shows it has ' +
    'what the task needs (its Folders, Shell commands, connectors); a task that merely looks ' +
    'like its field is not enough';
  const yourself = 'do the work yourself ONLY if your own tools and folders cover it';
  const truth =
    'otherwise tell the user the truth: what failed and what is missing, via your delivery tool';
  if (state.slug !== null && state.streak >= SAME_AGENT_FAILURE_CAP) {
    // Worded to hold in BOTH places that read it: the payload of the failure
    // that reaches the cap, and the gate that refuses the next call.
    const delivered = ctx.childLeftFiles
      ? CHILD_FILES_PARAGRAPH
      : 'Nothing it was asked has been delivered.';
    return (
      `${tool} has failed ${state.streak} times in a row on this job: DO NOT retry the ` +
      `same specialist, it is blocked. ${delivered} ${noPromise} ` +
      `Your options: (1) ${elsewhere}; (2) ${yourself}; (3) ${truth}. ` +
      'Then call return_result with the honest status.'
    );
  }
  const opening = ctx.childLeftFiles
    ? CHILD_FILES_PARAGRAPH
    : 'This delegation delivered NOTHING usable.';
  return (
    `${opening} ${noPromise} In this order: ` +
    `(1) if the result names a precise blocking point and this agent's roster entry shows it ` +
    `has what that point needs, call ${tool} ONCE more with a brief about that point only ` +
    `(a second failure in a row blocks it); (2) ${elsewhere}; (3) ${yourself}; (4) ${truth}. ` +
    'Then call return_result with the honest status.'
  );
}

/**
 * The refusal the runner gives a delegation to an agent blocked on this job
 * (execute.ts, `delegation_retry_blocked`).
 *
 * It reads what the LAST failed child of that agent under this job left, with
 * the very functions resumeDelegated used a moment earlier (readFilesWrittenBy,
 * filesTheChildWrote): the second failure may have left a file the parent was
 * just told to keep, and a refusal saying "nothing delivered" would contradict
 * it, and invite a redo that overwrites it (Codex review of #510, pass 3). One
 * source for both messages.
 */
export async function retryBlockedMessage(
  db: AnyDrizzleDb,
  args: { parentJobId: JobId; entityId: string; childSlug: string; state: FailedDelegationState },
): Promise<string> {
  const [childAgent] = await db
    .select({ id: agents.id })
    .from(agents)
    .where(and(eq(agents.slug, args.childSlug), eq(agents.entityId, args.entityId)))
    .limit(1);
  const [lastChild] = childAgent
    ? await db
        .select({ id: agentJobs.id })
        .from(agentJobs)
        .where(
          and(
            eq(agentJobs.parentJobId, args.parentJobId as string),
            eq(agentJobs.agentId, childAgent.id),
          ),
        )
        .orderBy(desc(agentJobs.createdAt))
        .limit(1)
    : [];
  const files = lastChild ? await readFilesWrittenBy(db, lastChild.id as JobId) : [];
  const kept = filesTheChildWrote(files);
  const guidance = failedDelegationGuidance(args.state, { childLeftFiles: kept.length > 0 });
  return kept.length > 0
    ? `delegation_retry_blocked: ${guidance}\n\n${JSON.stringify({ files_written: files }, null, 2)}`
    : `delegation_retry_blocked: ${guidance}`;
}
