// delivery-stub.ts — stub for cross-package result delivery (Brique 15 implements)
// When a job completes, this is called to deliver the result to the user.
// For now: no-op. Brique 15 will implement Telegram + email delivery.

export interface DeliveryTarget {
  channel: string;
  chatId: string | null;
  result: string;
  jobId: string;
  agentId: string | null;
  entityId: string | null;
}

/**
 * Deliver a completed job result to the appropriate channel.
 *
 * STUB: Brique 15 (packages/delivery) will implement this.
 * Current behavior: no-op (result is stored in DB, dashboard polls it).
 */
export async function deliverResult(_target: DeliveryTarget): Promise<void> {
  // TODO(brique-15): implement Telegram + email delivery
  // For now the result lives in agent_jobs.result — dashboard polls via SSE
}
