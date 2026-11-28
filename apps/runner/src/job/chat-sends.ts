// job/chat-sends.ts — which calls of a job sent a text to a given chat.
//
// THE ONE READER of "this step sent to this chat" (#1215, #1203). The harness
// delivers a job's answer unless the step that produced it sent it to the chat
// that asked (job/answer-delivery.ts); whether a step did is read HERE, from
// the stored tool calls, never from a flag kept in memory: a run resumed after
// an approval, or after a restart, reads the same rows.
//
// What a row says (#1184): its OUTCOME and its TARGET, written once by the
// seam (`tool_calls.outcome`, `tool_calls.target`), read by `readCallOutcome`.
// The text send tool reports the chat it resolved as its target
// (`chatTarget(channel, chatId)`), whatever form the model gave the address in:
//   - a send the platform accepted is `done` → `confirmed`;
//   - a send that timed out after it was transmitted is `unknown` → `unknown`:
//     the message may or may not be there, and the caller says what it does
//     about it (the one source of "unconfirmed", answer-delivery.ts);
//   - any other outcome sent nothing to anyone.
//
// Only the TEXT send tool is read: a file, an image, a voice note is never the
// answer of a job (their target names the item as well as the chat). A row
// written before 0170 carries no target, and is not counted as a send to any
// chat.

import { and, eq, inArray, toolCalls } from '@nodal-agents/db';
import type { AnyDrizzleDb } from '@nodal-agents/db';
import { chatTarget, readCallOutcome } from '@nodal-agents/shared';
import type { ChatSends, SendOutcome } from './final-answer.ts';

/** The tool that sends a text to a chat, on every messaging channel. */
const TEXT_SEND_TOOL = 'telegram_send_message';

/**
 * The calls of `jobId` that sent a text to `chat`, by tool-call id (the id the
 * transcript carries), with what is known of each.
 */
export async function sendsToChat(
  db: AnyDrizzleDb,
  jobId: string,
  chat: { channel: string; chatId: string },
): Promise<ChatSends> {
  const rows = await db
    .select({ toolCallId: toolCalls.toolCallId, outcome: toolCalls.outcome })
    .from(toolCalls)
    .where(
      and(
        eq(toolCalls.jobId, jobId),
        eq(toolCalls.toolName, TEXT_SEND_TOOL),
        eq(toolCalls.target, chatTarget(chat.channel, chat.chatId)),
      ),
    );
  const out = new Map<string, SendOutcome>();
  for (const row of rows) {
    if (row.toolCallId === null) continue;
    const outcome = readCallOutcome(row.outcome);
    if (outcome === 'done') out.set(row.toolCallId, 'confirmed');
    else if (outcome === 'unknown') out.set(row.toolCallId, 'unknown');
  }
  return out;
}

/**
 * Did this job send anything to anyone (a text, a file), successfully? What a
 * delegated child's parent is told (`[livraison effectuée : …]`), read from the
 * rows like the rest: the name of the last tool whose send is `done`, or `null`.
 */
export async function lastSuccessfulSendTool(
  db: AnyDrizzleDb,
  jobId: string,
  sendTools: ReadonlySet<string>,
): Promise<string | null> {
  if (sendTools.size === 0) return null;
  const rows = await db
    .select({ toolName: toolCalls.toolName, outcome: toolCalls.outcome, seq: toolCalls.seq })
    .from(toolCalls)
    .where(and(eq(toolCalls.jobId, jobId), inArray(toolCalls.toolName, [...sendTools])));
  let last: { name: string; seq: number } | null = null;
  for (const row of rows) {
    if (readCallOutcome(row.outcome) !== 'done') continue;
    if (last === null || row.seq > last.seq) last = { name: row.toolName, seq: row.seq };
  }
  return last?.name ?? null;
}
