// job/failure-notice.ts — what the person who asked reads when their job fails (#1180, #1086).
//
// THE RULE. "Failed" is written in one place (`failJob`, job/state.ts), and
// that place prepares the notice, in the transaction that writes `failed`.
// Whatever the reason, the runtime or the caller: a head job that fails leaves
// exactly one notice for the person, on the surface the request came from.
// No call site decides whether the person is told.
//
// WHERE IT GOES. The job's own reply destination, read from its row by the one
// resolver the other ends of a task use (`resolveDeliveryTarget`: the CLI
// runtime's answer, the board's summary):
//   - a request that came from a messaging chat (Telegram, WhatsApp, Discord,
//     Slack), or a trigger that designated one: an outbox row on that chat,
//     sent by the drain after the commit;
//   - a device or the dashboard: they read the end of the job on their own
//     stream (`job.failed` and the run state, pushed by the announcement the
//     same transaction queues, events/publish.ts). No outbox row: a second
//     path would tell them twice.
//
// WHO IS TOLD. Only the person's own job speaks to the person. A delegated
// child, a board task, any job with a parent, tells its parent through the
// path that already carries a child's result (the delegation record, the
// board's compilation). The parent's own end is what the person reads.
//
// WHAT IT SAYS. The failed row's `result`, as the failure writer settled it:
// the caller's explanation, or the children's compiled output, or the generic
// line naming the code. One explanation, the same on the job's page and in the
// chat; no sentence per error code is written here (invariant #2).
//
// WHEN IT CANNOT BE PREPARED. A job that has a chat but no channel that can
// carry it (no active channel for the agent, a designated chat whose platform
// nobody recorded): the row says so, in its result and its runner notes, and
// the log says so (invariant #4). Nothing is swallowed.

import { agentJobs, eq } from '@nodal-agents/db';
import type { AnyDrizzleDb } from '@nodal-agents/db';
import { prepareDelivery } from '../delivery/outbox.ts';
import {
  isDeliveryRefusal,
  resolveDeliveryTarget,
  type DeliveryTargetRefusal,
} from '../delivery/resolve-delivery-target.ts';

/** Logged when a job that has a chat ends failed with no notice prepared. */
export const FAILURE_NOTICE_NOT_PREPARED = 'FAILURE_NOTICE_NOT_PREPARED';

/** One failure notice per job: a second preparation is a bug, refused by the key. */
export function failureNoticeKey(jobId: string): string {
  return `${jobId}:failure`;
}

/** The refusals that say a fault: the job has a chat, and no channel can carry the notice. */
type NoticeFault = Extract<
  DeliveryTargetRefusal['refused'],
  'channel_inactive' | 'channel_unknown'
>;

export type FailureNoticeOutcome =
  /** An outbox row is prepared on this chat. */
  | { kind: 'prepared'; channel: string; chatId: string }
  /**
   * Nothing to prepare, and nothing is wrong: the job has a parent (it tells
   * it), no chat (its result is read where it was asked), or a chat on a
   * stream (a device reads `job.failed`).
   */
  | { kind: 'not_for_the_chat'; reason: 'has_parent' | 'no_chat' | 'read_from_stream' }
  /** The job has a chat, and no channel can carry the notice. */
  | { kind: 'unreachable'; reason: NoticeFault };

/**
 * The platform line a failed row carries when its notice could not be
 * prepared: a typed code in the frame of the runner's other stop lines.
 */
export function noticeNotPreparedLine(reason: NoticeFault): string {
  return `[this failure could not be sent to the chat: ${reason}]`;
}

/**
 * Prepares, in `tx` (the transaction that has just written `failed` and settled
 * `result`), the one notice of this failure. Reads the row: its parent, its
 * chat, its origin, and the result to send.
 */
export async function prepareFailureNotice(
  tx: AnyDrizzleDb,
  jobId: string,
): Promise<FailureNoticeOutcome> {
  const [row] = await tx
    .select({
      parentJobId: agentJobs.parentJobId,
      chatId: agentJobs.chatId,
      agentId: agentJobs.agentId,
      channel: agentJobs.channel,
      chatChannel: agentJobs.chatChannel,
      triggerContext: agentJobs.triggerContext,
      result: agentJobs.result,
    })
    .from(agentJobs)
    .where(eq(agentJobs.id, jobId))
    .limit(1);
  // The caller has just written this row in the same transaction.
  if (!row) throw new Error(`${FAILURE_NOTICE_NOT_PREPARED}: job ${jobId} not found`);
  if (row.parentJobId !== null) return { kind: 'not_for_the_chat', reason: 'has_parent' };

  const target = await resolveDeliveryTarget(tx, {
    chatId: row.chatId,
    agentId: row.agentId,
    channel: row.channel,
    chatChannel: row.chatChannel,
    triggerContext: row.triggerContext,
  });
  if (isDeliveryRefusal(target)) {
    if (target.refused === 'no_chat' || target.refused === 'read_from_stream') {
      return { kind: 'not_for_the_chat', reason: target.refused };
    }
    return { kind: 'unreachable', reason: target.refused };
  }
  const payload = (row.result ?? '').trim();
  // `failJob` guarantees an explanation before it gets here: an empty one is a
  // broken failure writer, said, never sent as a blank message.
  if (payload === '') throw new Error(`${FAILURE_NOTICE_NOT_PREPARED}: job ${jobId} has no result`);
  await prepareDelivery(tx, {
    jobId,
    channel: target.channel,
    chatId: target.chatId,
    payload,
    idempotencyKey: failureNoticeKey(jobId),
  });
  return { kind: 'prepared', channel: target.channel, chatId: target.chatId };
}
