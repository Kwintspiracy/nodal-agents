// telegram/poller.ts — long-poll Telegram for one bot.
//
// Loops until aborted. Each iteration:
//   1. getUpdates(offset, timeout=25)
//   2. for each update: { handleTelegramUpdate + advance offset } in one txn
//   3. after txn commits: triggerWorker (fire-and-forget)
//
// On `telegram_invalid_token` the loop exits cleanly — the user will reconnect
// the bot from the dashboard, which respawns a fresh poller.
// On other errors: exponential backoff (1s → 30s) then retry.

import { eq } from '@nodalai/db';
import { agents } from '@nodalai/db';
import {
  getTelegramUpdates,
  DeliveryError,
  type TelegramUpdate,
} from '@nodalai/delivery';
import type { RunnerDeps } from '../deps.ts';
import type { RunnerEnv } from '../env.ts';
import { handleTelegramUpdate, triggerJobWorker } from './handler.ts';

export interface PollerOpts {
  agentId: string;
  agentEntityId: string;
  botToken: string;
  /**
   * Bot's @username (without the @). Used by the handler to detect mentions
   * in group chats. Null is allowed for bots that haven't been getMe-validated
   * yet (mention triggers will simply be ignored in that case).
   */
  botUsername: string | null;
  /** The starting offset (next update_id to fetch). Loaded from DB. */
  startOffset: number;
  signal: AbortSignal;
  deps: RunnerDeps;
  env: RunnerEnv;
  /** Long-poll timeout in seconds. Default 25 (Telegram caps at 50). */
  longPollSeconds?: number;
}

export interface PollerExit {
  /** Why did the loop stop. */
  reason: 'aborted' | 'invalid_token';
  /** Last persisted offset (for tests / observability). */
  finalOffset: number;
}

const BACKOFF_INITIAL_MS = 1000;
const BACKOFF_MAX_MS = 30_000;

/**
 * Run the poll loop until `signal` is aborted or the bot token is rejected.
 * Resolves only when the loop exits — callers (the manager) keep this promise
 * so they can await all pollers on shutdown.
 */
export async function runTelegramPoller(opts: PollerOpts): Promise<PollerExit> {
  const { agentId, agentEntityId, botToken, botUsername, signal, deps, env } = opts;
  const longPoll = opts.longPollSeconds ?? 25;
  let offset = opts.startOffset;
  let backoffMs = BACKOFF_INITIAL_MS;

  while (!signal.aborted) {
    let updates: TelegramUpdate[];
    try {
      updates = await getTelegramUpdates({
        botToken,
        offset,
        timeout: longPoll,
        signal,
      });
    } catch (err) {
      if (signal.aborted) break;

      if (err instanceof DeliveryError && err.code === 'telegram_invalid_token') {
        // The token was revoked, deleted, or rotated. Stop polling — the next
        // (re)configuration via the dashboard will respawn this poller.
        console.warn(
          `[telegram-poller agent=${agentId}] invalid_token; stopping`,
        );
        return { reason: 'invalid_token', finalOffset: offset };
      }

      // Transient error — back off and retry. Don't burn CPU on hard failures.
      console.warn(
        `[telegram-poller agent=${agentId}] transient error: ${
          err instanceof Error ? err.message : String(err)
        }; backing off ${backoffMs}ms`,
      );
      await sleepWithAbort(backoffMs, signal);
      backoffMs = Math.min(backoffMs * 2, BACKOFF_MAX_MS);
      continue;
    }

    // Recovered from any transient — reset backoff.
    backoffMs = BACKOFF_INITIAL_MS;

    for (const update of updates) {
      if (signal.aborted) break;

      const newOffset = update.update_id + 1;
      let createdJobId: string | undefined;

      try {
        // Atomic: create job + advance offset. If anything throws, the txn
        // rolls back and we re-deliver this update on the next loop.
        await deps.db.transaction(async (tx) => {
          const result = await handleTelegramUpdate({
            update,
            receivingAgentId: agentId,
            receivingAgentEntityId: agentEntityId,
            receivingAgentBotUsername: botUsername,
            tx: tx as unknown as RunnerDeps['db'],
          });
          await tx
            .update(agents)
            .set({ telegramOffset: newOffset, updatedAt: new Date() })
            .where(eq(agents.id, agentId));

          createdJobId = result.jobId;
        });
      } catch (err) {
        console.error(
          `[telegram-poller agent=${agentId}] handle update_id=${update.update_id} failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        // Don't advance offset; next loop will retry the same update.
        // Backoff to avoid hot-looping on a poison message.
        await sleepWithAbort(backoffMs, signal);
        backoffMs = Math.min(backoffMs * 2, BACKOFF_MAX_MS);
        continue;
      }

      offset = newOffset;
      backoffMs = BACKOFF_INITIAL_MS;

      // Fire worker AFTER commit so we never wake a worker for a rolled-back job.
      if (createdJobId) {
        triggerJobWorker(createdJobId, env);
      }
    }
  }

  return { reason: 'aborted', finalOffset: offset };
}

// ─── helpers ──────────────────────────────────────────────────────────────────

/** sleep(ms) but resolves immediately if `signal` aborts. */
function sleepWithAbort(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      resolve();
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
