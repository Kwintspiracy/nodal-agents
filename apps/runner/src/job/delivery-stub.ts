// delivery-stub.ts — wires @nodalai/delivery into the runner
// Brique 15: real Telegram + email (placeholder) delivery implemented.

import { deliverResult as _deliverResult } from '@nodalai/delivery';
import type { AnyDrizzleDb } from '@nodalai/db';

export interface DeliveryTarget {
  channel: string;
  chatId: string | null;
  result: string;
  jobId: string;
  agentId: string | null;
  entityId: string | null;
}

export interface DeliveryRunnerDeps {
  db: AnyDrizzleDb;
  env: { TELEGRAM_BOT_TOKEN?: string };
}

/**
 * Deliver a completed job result to the appropriate channel.
 *
 * Delegates to @nodalai/delivery.deliverResult — resolves channel, formats,
 * splits long messages, and dispatches via Telegram / email (placeholder) / log.
 */
export async function deliverResult(jobId: string, deps: DeliveryRunnerDeps): Promise<void> {
  await _deliverResult(jobId, {
    db: deps.db,
    telegramBotToken: deps.env.TELEGRAM_BOT_TOKEN,
  });
}
