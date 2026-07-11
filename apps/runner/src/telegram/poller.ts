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

import { eq, and } from '@nodal-agents/db';
import { agents, telegramAllowedChats, channelBindings } from '@nodal-agents/db';
import {
  getTelegramUpdates,
  sendTelegramMessage,
  DeliveryError,
  type TelegramUpdate,
} from '@nodal-agents/delivery';
import type { RunnerDeps } from '../deps.ts';
import type { RunnerEnv } from '../env.ts';
import {
  handleTelegramUpdate,
  triggerJobWorker,
  attachInboundPhoto,
  type HandleResult,
} from './handler.ts';
import { handleApprovalCallback } from './approval-callback.ts';
import {
  handleAuthCallback,
  parseAuthCallbackData,
  buildAuthConfirmKeyboard,
} from './auth-callback.ts';

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
 * A poison update (one that throws deterministically while being handled)
 * must not stall the poller forever (M-16): since offset never advances past
 * an update that keeps failing, and getUpdates keeps returning it first, the
 * bot goes mute for ALL chats — not just the one that sent the bad message.
 * After this many attempts, the update is dead-lettered: logged loudly with
 * full context (never a silent drop — invariant #4) and skipped by advancing
 * the offset past it, so the rest of the queue keeps flowing.
 *
 * 5 (not 3): a transient blip (DB pool exhaustion, a Postgres restart, a
 * network hiccup) must have room to resolve itself before an update is given
 * up on permanently. With the per-update exponential backoff below, 5
 * attempts spans ~15s of retries before dead-lettering — long enough to ride
 * out a passing incident, short enough to still shed a genuine poison
 * message quickly.
 */
const MAX_UPDATE_ATTEMPTS = 5;

/**
 * Backoff for a given update's Nth retry attempt — deterministic and strictly
 * increasing from `attempts` alone, NOT from the poll-loop's shared `backoffMs`
 * (which tracks a different concern: transient `getUpdates` failures against
 * Telegram itself, and gets reset by whichever update happens to succeed
 * next). Conflating the two meant a per-update backoff wasn't guaranteed to
 * grow — this is scoped purely to "how long has THIS update been failing".
 */
function perUpdateBackoffMs(attempts: number): number {
  return Math.min(BACKOFF_INITIAL_MS * 2 ** (attempts - 1), BACKOFF_MAX_MS);
}

// Node's own socket-level error codes — the TCP connection to Postgres itself
// dropped, refused, or timed out. Nothing to do with any query's content.
const NODE_NETWORK_ERROR_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENOTFOUND',
  'EPIPE',
  'EAI_AGAIN',
]);

// `packages/db` uses the `postgres` (postgres.js) driver (see
// packages/db/src/client.ts). Verified against its installed source
// (node_modules/postgres/src/connection.js): a dropped/torn-down/timed-out
// pool connection rejects the in-flight query with one of these `.code`
// values — again, about the CONNECTION, never the query's content.
const POSTGRES_JS_CONNECTION_ERROR_CODES = new Set([
  'CONNECT_TIMEOUT',
  'CONNECTION_DESTROYED',
  'CONNECTION_CLOSED',
  'CONNECTION_ENDED',
]);

// Postgres server-side SQLSTATE codes (the `C`/code field of a wire-protocol
// ErrorResponse — see errorFields in the same source) for genuine infra
// conditions: the server itself unavailable, restarting, or shedding load.
// The `08` class is `connection_exception` (08000/08001/08003/08004/08006/…).
const POSTGRES_SQLSTATE_INFRA_CODES = new Set([
  '57P01', // admin_shutdown
  '57P02', // crash_shutdown
  '57P03', // cannot_connect_now
  '53300', // too_many_connections
  '53400', // configuration_limit_exceeded
]);

/**
 * Classify an error as infrastructure-transient (DB connection refused/reset,
 * pool exhaustion, Postgres restarting, a network blip) versus a deterministic
 * failure caused by the CONTENT of the update itself (a message shape the
 * handler chokes on, a parsing bug, ...).
 *
 * This distinction matters because `getTelegramUpdates` talks to Telegram, not
 * the DB — during a DB blip it keeps succeeding and handing back the same
 * batch, so EVERY update in flight fails at `db.transaction(...)` for a
 * reason that has nothing to do with any one update_id. Counting that toward
 * M-16's per-update dead-letter threshold would permanently drop a perfectly
 * legitimate message the moment Postgres hiccups for ~15s — worse than the
 * bug M-16 set out to fix.
 *
 * Bias: when a specific error code's classification is genuinely ambiguous,
 * this list errs toward INCLUDING it as transient — losing a real message to
 * infra flakiness is worse than retrying a genuine poison update a few extra
 * rounds. An error that matches NOTHING here falls through to the existing
 * deterministic/dead-letter path (M-16's proven, bounded behavior) instead of
 * retrying forever on a total unknown.
 */
function isTransientInfraError(err: unknown): boolean {
  if (!err || typeof err !== 'object' || !('code' in err)) return false;
  const code = String((err as { code: unknown }).code);
  if (NODE_NETWORK_ERROR_CODES.has(code)) return true;
  if (POSTGRES_JS_CONNECTION_ERROR_CODES.has(code)) return true;
  if (code.startsWith('08')) return true; // SQLSTATE class 08: connection_exception
  if (POSTGRES_SQLSTATE_INFRA_CODES.has(code)) return true;
  return false;
}

// Agent ids we've already logged a "no channel_bindings row yet" warning for
// — module-level so a poller that never has a binding (the common case until
// S4 ships the dashboard writer) doesn't re-log on every single update.
const loggedMissingBindingFor = new Set<string>();

/**
 * S3 dual-write: mirror the getUpdates offset into channel_bindings.cursor
 * for this agent's telegram binding, IF one exists. A cheap secondary write —
 * migration 0064 only back-fills channel_bindings once at migrate time, so
 * most installs have no row yet until a later channel operation creates one;
 * that's non-fatal here, just a one-time log so it's diagnosable, never a
 * throw (the legacy agents.telegram_offset write above is the one that must
 * never be blocked by this).
 */
async function mirrorOffsetToBinding(
  db: RunnerDeps['db'],
  agentId: string,
  offset: number,
): Promise<void> {
  try {
    const updated = await db
      .update(channelBindings)
      .set({ cursor: String(offset), updatedAt: new Date() })
      .where(and(eq(channelBindings.agentId, agentId), eq(channelBindings.channel, 'telegram')))
      .returning({ id: channelBindings.id });
    if (updated.length === 0 && !loggedMissingBindingFor.has(agentId)) {
      loggedMissingBindingFor.add(agentId);
      console.warn(
        `[telegram-poller agent=${agentId}] no channel_bindings row for channel='telegram' yet — ` +
          'offset cursor mirror is a no-op until one exists (not fatal).',
      );
    }
  } catch (err) {
    console.warn(
      `[telegram-poller agent=${agentId}] failed to mirror offset into channel_bindings.cursor: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

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
  // Separate from `backoffMs`: that variable is reset to BACKOFF_INITIAL_MS
  // every time `getTelegramUpdates` (a Telegram API call) succeeds — which it
  // keeps doing throughout a DB-only outage, since Telegram itself is fine.
  // Reusing `backoffMs` for DB/infra-transient errors would get its escalation
  // wiped every single outer-loop iteration, capping the effective backoff at
  // BACKOFF_INITIAL_MS forever instead of growing toward BACKOFF_MAX_MS during
  // a prolonged outage. `dbBackoffMs` tracks DB health specifically: it grows
  // on a transient-infra error and resets only when a DB operation actually
  // succeeds again.
  let dbBackoffMs = BACKOFF_INITIAL_MS;
  // Per-update_id failure count (M-16). Bounded: an entry is removed the moment
  // its update either succeeds or is dead-lettered, so this never accumulates
  // beyond "currently-failing updates we haven't given up on yet".
  const failureCounts = new Map<number, number>();

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
        console.warn(`[telegram-poller agent=${agentId}] invalid_token; stopping`);
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

      // callback_query = an inline-button tap (e.g. an approval ✅/❌). It resolves
      // an existing job rather than creating one, so it bypasses the message txn
      // path below. The handler resolves + resumes internally and is best-effort
      // on the Telegram side; only a hard DB failure (thrown) blocks offset
      // advancement so we retry the same tap.
      if (update.callback_query) {
        try {
          // Route by callback_data prefix: `tgauth:` = an inbound-chat
          // authorization decision (H-1); anything else = an approval tap.
          if (parseAuthCallbackData(update.callback_query.data)) {
            await handleAuthCallback({ update, receivingAgentId: agentId, botToken, deps });
          } else {
            await handleApprovalCallback({
              update,
              receivingAgentId: agentId,
              botToken,
              deps,
              env,
            });
          }
          await deps.db
            .update(agents)
            .set({ telegramOffset: newOffset, updatedAt: new Date() })
            .where(eq(agents.id, agentId));
          await mirrorOffsetToBinding(deps.db, agentId, newOffset);
          // A DB write just succeeded — the DB is healthy again.
          dbBackoffMs = BACKOFF_INITIAL_MS;
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          const chatId = update.callback_query.message?.chat?.id ?? 'unknown';

          if (isTransientInfraError(err)) {
            // The DB/infra itself is the problem, not this update's content —
            // never count this toward the per-update dead-letter threshold
            // (it would unfairly condemn whichever update happens to be first
            // in the queue during a blip). Back off on `dbBackoffMs` — NOT the
            // outer `backoffMs`, which gets reset every time the (unrelated)
            // Telegram fetch succeeds and would never let this escalate — and
            // retry the same batch once the outer loop comes back around.
            console.warn(
              `[telegram-poller agent=${agentId}] callback update_id=${update.update_id} chat=${chatId} transient infra error: ${errMsg}; backing off ${dbBackoffMs}ms`,
            );
            await sleepWithAbort(dbBackoffMs, signal);
            dbBackoffMs = Math.min(dbBackoffMs * 2, BACKOFF_MAX_MS);
            break;
          }

          const attempts = (failureCounts.get(update.update_id) ?? 0) + 1;

          if (attempts >= MAX_UPDATE_ATTEMPTS) {
            console.error(
              `[telegram-poller agent=${agentId}] callback update_id=${update.update_id} chat=${chatId} DEAD-LETTERED after ${attempts} attempts, skipping: ${errMsg}`,
            );
            // Advance past the poison update ourselves — the normal in-handler
            // offset write never ran because the handler itself threw. This
            // write can ALSO fail if the DB happens to go down at this exact
            // moment — never silently declare a drop we couldn't persist.
            try {
              await deps.db
                .update(agents)
                .set({ telegramOffset: newOffset, updatedAt: new Date() })
                .where(eq(agents.id, agentId));
              await mirrorOffsetToBinding(deps.db, agentId, newOffset);
              dbBackoffMs = BACKOFF_INITIAL_MS;
            } catch (advanceErr) {
              console.error(
                `[telegram-poller agent=${agentId}] callback update_id=${update.update_id} chat=${chatId} failed to persist dead-letter offset advance: ${
                  advanceErr instanceof Error ? advanceErr.message : String(advanceErr)
                }; will retry`,
              );
              await sleepWithAbort(dbBackoffMs, signal);
              dbBackoffMs = Math.min(dbBackoffMs * 2, BACKOFF_MAX_MS);
              break;
            }
            // Safe to `continue` to the next update in this batch: we are
            // deliberately skipping THIS one, not silently jumping past one
            // still pending retry.
            failureCounts.delete(update.update_id);
            offset = newOffset;
            continue;
          }

          failureCounts.set(update.update_id, attempts);
          console.error(
            `[telegram-poller agent=${agentId}] callback update_id=${update.update_id} chat=${chatId} failed (attempt ${attempts}/${MAX_UPDATE_ATTEMPTS}): ${errMsg}`,
          );
          await sleepWithAbort(perUpdateBackoffMs(attempts), signal);
          // `break`, not `continue`: `offset` is shared across this whole batch.
          // If a LATER update in `updates` were processed and succeeded next, it
          // would write `offset` past this one's still-unresolved update_id —
          // Telegram's offset semantics are "confirm everything below this id",
          // so that later update would PERMANENTLY erase this one from the queue
          // (silent drop, invariant #4) without ever reaching MAX_UPDATE_ATTEMPTS.
          // Stopping the batch here just delays the rest by one poll cycle —
          // they're re-fetched (not lost) once this one is retried or dead-lettered.
          break;
        }
        failureCounts.delete(update.update_id);
        offset = newOffset;
        continue;
      }

      let createdJobId: string | undefined;
      let createdPhoto: HandleResult['photo'];
      let createdPendingAuth: HandleResult['pendingAuth'];

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
          await mirrorOffsetToBinding(tx as unknown as RunnerDeps['db'], agentId, newOffset);

          createdJobId = result.jobId;
          createdPhoto = result.photo;
          createdPendingAuth = result.pendingAuth;
        });
        // The transaction just committed — the DB is healthy again.
        dbBackoffMs = BACKOFF_INITIAL_MS;
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        const chatId = update.message?.chat?.id ?? 'unknown';

        if (isTransientInfraError(err)) {
          // The DB/infra itself is the problem, not this update's content —
          // never count this toward the per-update dead-letter threshold (it
          // would unfairly condemn whichever update happens to be first in
          // the queue during a blip). Back off on `dbBackoffMs` — NOT the
          // outer `backoffMs`, which gets reset every time the (unrelated)
          // Telegram fetch succeeds and would never let this escalate — and
          // retry the same batch once the outer loop comes back around —
          // exactly like before M-16 existed, this update is never lost, only
          // delayed until the DB recovers.
          console.warn(
            `[telegram-poller agent=${agentId}] update_id=${update.update_id} chat=${chatId} transient infra error: ${errMsg}; backing off ${dbBackoffMs}ms`,
          );
          await sleepWithAbort(dbBackoffMs, signal);
          dbBackoffMs = Math.min(dbBackoffMs * 2, BACKOFF_MAX_MS);
          break;
        }

        const attempts = (failureCounts.get(update.update_id) ?? 0) + 1;

        if (attempts >= MAX_UPDATE_ATTEMPTS) {
          // Give up on this update — a message that fails deterministically
          // K times in a row would otherwise wedge the offset forever, going
          // mute for every chat this bot serves (M-16). Log loudly with full
          // context (never a silent drop) and skip it: advance offset past it.
          console.error(
            `[telegram-poller agent=${agentId}] update_id=${update.update_id} chat=${chatId} DEAD-LETTERED after ${attempts} attempts, skipping: ${errMsg}`,
          );
          // This write can ALSO fail if the DB happens to go down at this
          // exact moment — never silently declare a drop we couldn't persist.
          try {
            await deps.db
              .update(agents)
              .set({ telegramOffset: newOffset, updatedAt: new Date() })
              .where(eq(agents.id, agentId));
            await mirrorOffsetToBinding(deps.db, agentId, newOffset);
            dbBackoffMs = BACKOFF_INITIAL_MS;
          } catch (advanceErr) {
            console.error(
              `[telegram-poller agent=${agentId}] update_id=${update.update_id} chat=${chatId} failed to persist dead-letter offset advance: ${
                advanceErr instanceof Error ? advanceErr.message : String(advanceErr)
              }; will retry`,
            );
            await sleepWithAbort(dbBackoffMs, signal);
            dbBackoffMs = Math.min(dbBackoffMs * 2, BACKOFF_MAX_MS);
            break;
          }
          // Safe to `continue`: we are deliberately skipping THIS update, not
          // silently jumping past a later one still pending retry.
          failureCounts.delete(update.update_id);
          offset = newOffset;
          continue;
        }

        failureCounts.set(update.update_id, attempts);
        console.error(
          `[telegram-poller agent=${agentId}] update_id=${update.update_id} chat=${chatId} failed (attempt ${attempts}/${MAX_UPDATE_ATTEMPTS}): ${errMsg}`,
        );
        // Don't advance offset; next loop will retry the same update.
        await sleepWithAbort(perUpdateBackoffMs(attempts), signal);
        // `break`, not `continue`: `offset` is shared across this whole batch.
        // If we instead moved on to the NEXT update and it succeeded, it would
        // write `offset` past THIS update's still-unresolved id — Telegram's
        // offset semantics confirm everything below it, so this update would be
        // permanently erased from the queue (silent drop, invariant #4) without
        // ever reaching MAX_UPDATE_ATTEMPTS. Stopping the batch here only delays
        // the rest by one poll cycle — they're re-fetched, never lost, once this
        // one is retried or dead-lettered.
        break;
      }

      failureCounts.delete(update.update_id);
      offset = newOffset;

      // Inbound photo: download it (network — out of the txn) and attach it to
      // the job BEFORE the worker runs, so the agent sees the image. Best-effort:
      // a failed download leaves the job text-only and the worker still runs.
      if (createdJobId && createdPhoto) {
        try {
          await attachInboundPhoto({
            jobId: createdJobId,
            entityId: agentEntityId,
            botToken,
            photo: createdPhoto,
            db: deps.db,
          });
        } catch (err) {
          console.warn(
            `[telegram-poller agent=${agentId}] photo attach failed for job ${createdJobId}: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      }

      // Fire worker AFTER commit so we never wake a worker for a rolled-back job.
      if (createdJobId) {
        triggerJobWorker(createdJobId, env);
      }

      // H-1: an unknown chat asked for access — ask the owner to confirm (out of
      // the txn: network I/O). Best-effort with a safety net: if the owner card
      // can't be sent, delete the pending row so a later message re-asks rather
      // than leaving the requester stuck in limbo forever.
      if (createdPendingAuth) {
        await sendAuthConfirmation(botToken, createdPendingAuth).catch(async (err) => {
          console.warn(
            `[telegram-poller agent=${agentId}] auth-confirm send failed for chat ${
              createdPendingAuth!.requesterChatId
            }: ${err instanceof Error ? err.message : String(err)}; clearing pending row`,
          );
          await deps.db
            .delete(telegramAllowedChats)
            .where(eq(telegramAllowedChats.id, createdPendingAuth!.allowedChatId))
            .catch(() => {});
        });
      }
    }
  }

  return { reason: 'aborted', finalOffset: offset };
}

/**
 * Send the owner an inline-button card to allow/deny a new chat, and tell the
 * requester their request is pending. The owner card is the load-bearing send —
 * if it throws, the caller clears the pending row so the request can re-open.
 * The requester note is best-effort and never blocks.
 */
async function sendAuthConfirmation(
  botToken: string,
  pending: NonNullable<HandleResult['pendingAuth']>,
): Promise<void> {
  // A /ask-relayed request targets a SIBLING agent — name it on the card so
  // the owner knows exactly which agent's access they are granting (H3).
  const target = pending.targetAgentName
    ? `souhaite parler à l'agent « ${pending.targetAgentName} » via ce bot`
    : 'souhaite parler à ce bot';
  await sendTelegramMessage({
    botToken,
    chatId: pending.ownerChatId,
    text: `👤 ${pending.requesterName} (chat ${pending.requesterChatId}) ${target}. Autoriser ?`,
    inlineKeyboard: buildAuthConfirmKeyboard(pending.allowedChatId),
  });
  // Let the requester know they're waiting — best-effort, never fatal.
  await sendTelegramMessage({
    botToken,
    chatId: pending.requesterChatId,
    text: 'Votre demande a été transmise au propriétaire du bot pour autorisation. Vous pourrez écrire dès qu’elle est acceptée.',
  }).catch(() => {});
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
