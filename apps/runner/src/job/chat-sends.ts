// job/chat-sends.ts — which calls of a job sent a text to a given chat.
//
// THE ONE READER of "this step sent to this chat" (#1215, #1203). The harness
// delivers a job's answer unless the step that produced it sent it to the chat
// that asked (job/answer-delivery.ts); whether a step did is read HERE, from
// the stored tool calls, never from a flag kept in memory: a run resumed after
// an approval, or after a restart, reads the same rows.
//
// What a row says (packages/tools/src/communication/receipt.ts):
//   - a send the platform accepted keeps its receipt: the channel and the chat
//     the call resolved (whatever form the model gave the address in), and the
//     platform's message id → `confirmed`;
//   - a send that timed out after it was transmitted keeps where it was going
//     (`attempt`), with `mayHaveDelivered` → `unknown`: the message may or may
//     not be there, and the caller says what it does about it;
//   - any other failure sent nothing to anyone.
//
// Only the TEXT send tool is read: a file, an image, a voice note is never the
// answer of a job. A row written before the receipt existed carries no
// destination, and is not counted as a send to any chat.
//
// The next change of this stack (the typed outcome and target of a tool call)
// replaces the inside of this function, and nothing around it.

import { and, eq, toolCalls } from '@nodal-agents/db';
import type { AnyDrizzleDb } from '@nodal-agents/db';
import type { ChatSends, SendOutcome } from './final-answer.ts';

/** The tool that sends a text to a chat, on every messaging channel. */
const TEXT_SEND_TOOL = 'telegram_send_message';

interface Destination {
  channel?: unknown;
  chatId?: unknown;
}

function sameChat(d: Destination | undefined, chat: { channel: string; chatId: string }): boolean {
  return d !== undefined && d.channel === chat.channel && d.chatId === chat.chatId;
}

/** What one stored call of the text send tool says about `chat`, or `null`: nothing sent there. */
function outcomeFor(
  toolOutput: string | null,
  chat: { channel: string; chatId: string },
): SendOutcome | null {
  if (toolOutput === null) return null;
  let parsed: {
    sent?: unknown;
    receipt?: Destination;
    outcome?: unknown;
    mayHaveDelivered?: unknown;
    output?: { attempt?: Destination };
  };
  try {
    parsed = JSON.parse(toolOutput) as typeof parsed;
  } catch {
    // The seam writes JSON; a row that is not is not a send this reader knows.
    return null;
  }
  if (parsed.sent === true) return sameChat(parsed.receipt, chat) ? 'confirmed' : null;
  if (parsed.outcome === 'error' && parsed.mayHaveDelivered === true) {
    return sameChat(parsed.output?.attempt, chat) ? 'unknown' : null;
  }
  return null;
}

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
    .select({ toolCallId: toolCalls.toolCallId, toolOutput: toolCalls.toolOutput })
    .from(toolCalls)
    .where(and(eq(toolCalls.jobId, jobId), eq(toolCalls.toolName, TEXT_SEND_TOOL)));
  const out = new Map<string, SendOutcome>();
  for (const row of rows) {
    if (row.toolCallId === null) continue;
    const outcome = outcomeFor(row.toolOutput, chat);
    if (outcome !== null) out.set(row.toolCallId, outcome);
  }
  return out;
}

/**
 * Did this job send anything to anyone (a text, a file), successfully? What a
 * delegated child's parent is told (`[livraison effectuée : …]`), read from the
 * rows like the rest: the name of the last tool that did, or `null`.
 */
export async function lastSuccessfulSendTool(
  db: AnyDrizzleDb,
  jobId: string,
  sendTools: ReadonlySet<string>,
): Promise<string | null> {
  const rows = await db
    .select({ toolName: toolCalls.toolName, toolOutput: toolCalls.toolOutput, seq: toolCalls.seq })
    .from(toolCalls)
    .where(eq(toolCalls.jobId, jobId));
  let last: { name: string; seq: number } | null = null;
  for (const row of rows) {
    if (!sendTools.has(row.toolName) || row.toolOutput === null) continue;
    let parsed: { receipt?: unknown };
    try {
      parsed = JSON.parse(row.toolOutput) as typeof parsed;
    } catch {
      continue;
    }
    if (parsed.receipt === undefined) continue;
    if (last === null || row.seq > last.seq) last = { name: row.toolName, seq: row.seq };
  }
  return last?.name ?? null;
}
