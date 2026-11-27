// communication/receipt.ts — what a send tool records of the platform's answer.
//
// A send tool's row says where the message went and what the platform
// answered, as the outbox's rows do (`job_deliveries.receipt`): the chat and
// the channel the call resolved, and the platform's message id. The model
// never reads it (`keptFromModel`): a message id handed to a model was once
// read as a word of the person (2026-09-08), and the model has no use for it.
//
// The runner reads these facts to know whether a step of a job sent its
// answer to the chat that asked (apps/runner/src/job/chat-sends.ts). A send
// that timed out after it was transmitted (`mayHaveDelivered`) keeps where it
// was going on its row too, under `attempt`: its outcome is unknown, and the
// runner says so rather than counting it either way.

import type { ChannelKind, SendResult } from '@nodal-agents/delivery';
import { ToolFailedWithOutput } from '../errors';

/** Where a send went, and the platform's id for it (`null`: none returned). */
export interface SendReceipt {
  channel: ChannelKind;
  chatId: string;
  messageId: string | null;
}

/** The key of a send tool's result that the row keeps and the model never reads. */
export const RECEIPT_KEY = 'receipt';

/** What the platform answered to a send, as the row keeps it. */
export function sendReceipt(
  recipient: { chatId: string; channel: ChannelKind },
  res: SendResult,
): SendReceipt {
  // Telegram answers '0' and WhatsApp '' when no id comes back: no id, said as such.
  const id = res.messageId;
  return {
    channel: recipient.channel,
    chatId: recipient.chatId,
    messageId: id === '' || id === '0' ? null : id,
  };
}

/**
 * The error a send tool hands on when the platform never answered a request
 * that was transmitted: the same message for the model, the same
 * `mayHaveDelivered` for the runner, and the destination on the call's row
 * (`attempt`). Any other error passes through unchanged.
 */
export function withSendAttempt(
  err: unknown,
  recipient: { chatId: string; channel: ChannelKind },
): unknown {
  if (
    !(err instanceof Error) ||
    (err as { mayHaveDelivered?: boolean }).mayHaveDelivered !== true
  ) {
    return err;
  }
  return Object.assign(
    new ToolFailedWithOutput(err.message, {
      attempt: { channel: recipient.channel, chatId: recipient.chatId },
    }),
    { mayHaveDelivered: true },
  );
}
