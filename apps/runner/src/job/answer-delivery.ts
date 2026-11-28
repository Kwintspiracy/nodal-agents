// job/answer-delivery.ts — the answer of a job asked on a chat goes to that
// chat, sent by the harness (#1215, #1203, part of #1170).
//
// THE RULE. "Completed" is written in one place (`completeJob`, job/state.ts),
// and that place prepares the delivery of the job's answer, in the transaction
// that writes `completed`, through the outbox: on every channel (Telegram,
// WhatsApp, Discord, Slack, and any channel added with an outbox adapter) and
// every runtime (Nodal's own loop, a CLI runtime, the board). It is the CLI
// runtime's way of answering, made the only one: a channel needs nothing but
// an outbox adapter to be answered, and no tool has to be called for it.
//
// NO DUPLICATE, DECIDED ON FACTS. The harness does not deliver what a send of
// the job already carried to that same chat in the step that gave the answer
// (`readRunAnswer`, job/final-answer.ts, reading `sendsToChat`, chat-sends.ts):
// a fact of the stored tool calls, by step and by destination, the same after
// a suspension, a resume or a restart. An earlier acknowledgement, a send to
// another chat, a progress note or a file are not the answer. A send whose
// outcome is unknown (the platform never answered a request that was
// transmitted) is not counted as delivered: its text is sent again, under a
// key that says why (`<answer key>:resend_unconfirmed`). The person receives
// the answer, at worst twice, and the row says it may be a second copy.
//
// WHERE IT GOES. The job's own reply destination, read from its row by the one
// resolver every end of a task uses (`resolveDeliveryTarget`): the chat the
// request came from, or the chat its trigger designated, on that chat's own
// channel. A device and the dashboard read the end of the job on their own
// stream; a job with no chat (an MCP caller, the API, a routine with no
// destination) is answered by its result, where it was asked.
//
// WHO IS TOLD. Only the person's own job speaks to the person: a job with a
// parent (a delegated child, a board task) answers its parent.
//
// WHAT IT SAYS. The words of the job (invariant #2): its result, as the gate
// settled it (the answer it gave, what `dashboard_publish` wrote, its
// children's output), or the summary a board's root wrote for the chat; when a
// send carried part of the answer, only what it did not carry, followed by the
// runner's own lines of the result (a stopped delegation).
//
// WHEN IT CANNOT BE PREPARED. A job with a chat that no channel can carry, or
// with no answer at all: the row says so, in its result and its runner notes,
// and the log says so (invariant #4).

import { agentJobs, eq } from '@nodal-agents/db';
import type { AnyDrizzleDb } from '@nodal-agents/db';
import { prepareDelivery } from '../delivery/outbox.ts';
import {
  isDeliveryRefusal,
  resolveDeliveryTarget,
  type DeliveryTarget,
  type DeliveryTargetRefusal,
} from '../delivery/resolve-delivery-target.ts';
import { sendsToChat } from './chat-sends.ts';
import { readRunAnswer } from './final-answer.ts';
import { currentTurnMessages } from './transcript-text.ts';

/** Logged when a job that has a chat completes with no answer prepared for it. */
export const ANSWER_NOT_PREPARED = 'ANSWER_NOT_PREPARED';

/** One answer per job: a second preparation is a bug, refused by the key. */
export function answerDeliveryKey(jobId: string): string {
  return `${jobId}:answer`;
}

/** The key of an answer sent again because the job's own send of it is unconfirmed. */
function resendKey(jobId: string): string {
  return `${answerDeliveryKey(jobId)}:resend_unconfirmed`;
}

/** Why an answer that should go to a chat could not be prepared. */
export type AnswerFault =
  | Extract<DeliveryTargetRefusal['refused'], 'channel_inactive' | 'channel_unknown'>
  | 'no_answer';

/**
 * The platform line a completed row carries when its answer could not be
 * prepared: a typed code, in the frame of the runner's other lines.
 */
export function answerNotPreparedLine(reason: AnswerFault): string {
  return `[this answer could not be sent to the chat: ${reason}]`;
}

/** Who reads the end of a job on a chat: the chat, or why nobody does there. */
export type AnswerReader =
  | { kind: 'chat'; target: DeliveryTarget }
  | { kind: 'not_for_the_chat'; reason: 'has_parent' | 'no_chat' | 'read_from_stream' }
  | { kind: 'unreachable'; reason: Exclude<AnswerFault, 'no_answer'> };

/** The fields of `agent_jobs` that say who reads the end of a job. */
export interface AnswerReaderJob {
  parentJobId: string | null;
  chatId: string | null;
  agentId: string | null;
  channel: string | null;
  chatChannel: string | null;
  triggerContext: unknown;
}

/**
 * Who reads the end of this job on a chat. One answer for the gate and for
 * the board, which asks it before paying a model call for a summary nobody
 * would read.
 */
export async function answerReader(db: AnyDrizzleDb, job: AnswerReaderJob): Promise<AnswerReader> {
  if (job.parentJobId !== null) return { kind: 'not_for_the_chat', reason: 'has_parent' };
  const target = await resolveDeliveryTarget(db, job);
  if (!isDeliveryRefusal(target)) return { kind: 'chat', target };
  if (target.refused === 'no_chat' || target.refused === 'read_from_stream') {
    return { kind: 'not_for_the_chat', reason: target.refused };
  }
  return { kind: 'unreachable', reason: target.refused };
}

export type AnswerDeliveryOutcome =
  /** An outbox row is prepared on this chat. */
  | { kind: 'prepared'; channel: string; chatId: string; resendsUnconfirmed: boolean }
  /** The job's own sends carried its answer to the chat: nothing is left to send. */
  | { kind: 'sent_by_the_job' }
  /** Nothing to prepare, and nothing is wrong (see `AnswerReader`). */
  | { kind: 'not_for_the_chat'; reason: 'has_parent' | 'no_chat' | 'read_from_stream' }
  /** The job has a chat, and its answer cannot reach it. */
  | { kind: 'unreachable'; reason: AnswerFault };

export interface PrepareAnswerOptions {
  /**
   * What the chat reads instead of the result, when the caller wrote one: the
   * short summary a board's root writes for the chat, its result being the
   * compilation of its tasks. Absent: the result.
   */
  readonly chatText?: string;
  /** The runner's lines the result ends with (#562): they go with the answer. */
  readonly runnerLines?: readonly string[];
}

/**
 * Prepares, in `tx` (the transaction that has just written `completed` and
 * settled `result`), the delivery of this job's answer to the chat that asked.
 * Reads the row (its parent, its chat, its origin, its transcript, its
 * result) and the stored calls of the job, for what its sends carried.
 */
export async function prepareAnswerDelivery(
  tx: AnyDrizzleDb,
  jobId: string,
  options: PrepareAnswerOptions = {},
): Promise<AnswerDeliveryOutcome> {
  const [row] = await tx
    .select({
      parentJobId: agentJobs.parentJobId,
      chatId: agentJobs.chatId,
      agentId: agentJobs.agentId,
      channel: agentJobs.channel,
      chatChannel: agentJobs.chatChannel,
      triggerContext: agentJobs.triggerContext,
      task: agentJobs.task,
      messages: agentJobs.messages,
      result: agentJobs.result,
    })
    .from(agentJobs)
    .where(eq(agentJobs.id, jobId))
    .limit(1);
  // The caller has just written this row in the same transaction.
  if (!row) throw new Error(`${ANSWER_NOT_PREPARED}: job ${jobId} not found`);

  const reader = await answerReader(tx, row);
  if (reader.kind !== 'chat') return reader;
  const { target } = reader;

  const turn = Array.isArray(row.messages)
    ? currentTurnMessages(row.messages as unknown[], row.task ?? '')
    : [];
  const answer = readRunAnswer(turn, await sendsToChat(tx, jobId, target));
  const lines = (options.runnerLines ?? []).filter((l) => l.trim() !== '');
  const payload =
    answer.unsent === null
      ? (options.chatText ?? row.result ?? '').trim()
      : [answer.unsent, ...lines].filter((t) => t.trim() !== '').join('\n\n');

  if (payload === '') {
    if (answer.unsent !== null) return { kind: 'sent_by_the_job' };
    return { kind: 'unreachable', reason: 'no_answer' };
  }
  await prepareDelivery(tx, {
    jobId,
    channel: target.channel,
    chatId: target.chatId,
    payload,
    idempotencyKey: answer.resendsUnconfirmed ? resendKey(jobId) : answerDeliveryKey(jobId),
  });
  return {
    kind: 'prepared',
    channel: target.channel,
    chatId: target.chatId,
    resendsUnconfirmed: answer.resendsUnconfirmed,
  };
}
