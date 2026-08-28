// telegram/manager.ts — orchestrate one TelegramPoller per configured agent.
//
// Lifecycle:
//   - On start: fetch all agents with `telegram_bot_token` set, spawn a poller
//     for each with its current `telegram_offset` as the starting cursor.
//   - Every `refreshIntervalMs` (default 30s): re-fetch the list, diff against
//     running pollers, start newcomers, abort removed-or-token-changed ones.
//   - On stop: abort every poller and await their exit.
//
// Why poll the DB for changes instead of pub/sub? KISS for MVT — single
// runner process, ~30s reaction time is fine for dashboard config changes.
// We can swap in pg_notify later if it matters.

import { isNotNull, eq, and } from '@nodal-agents/db';
import { agents, decryptChannelSecret } from '@nodal-agents/db';
import type { RunnerDeps } from '../deps.ts';
import type { RunnerEnv } from '../env.ts';
import { runTelegramPoller, type PollerExit } from './poller.ts';

export interface TelegramManagerOpts {
  env: RunnerEnv;
  /** How often to scan the DB for new/removed bots. Default 30s. */
  refreshIntervalMs?: number;
}

export interface TelegramManagerHandle {
  /** Stop refreshing + abort all pollers + await their exit. */
  stop(): Promise<void>;
  /** Force-refresh now (used by tests; production relies on the timer). */
  refreshNow(): Promise<void>;
  /** Number of pollers currently running (used by tests). */
  activeCount(): number;
}

interface ActivePoller {
  agentId: string;
  /** Token used by this poller. Used to detect token rotation. */
  botToken: string;
  controller: AbortController;
  /** Resolves when the poller's loop exits. */
  exit: Promise<PollerExit>;
}

const DEFAULT_REFRESH_MS = 30_000;

export function startTelegramManager(
  deps: RunnerDeps,
  opts: TelegramManagerOpts,
): TelegramManagerHandle {
  const refreshMs = opts.refreshIntervalMs ?? DEFAULT_REFRESH_MS;
  const active = new Map<string, ActivePoller>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;

  async function refresh(): Promise<void> {
    if (stopped) return;

    let rows: Array<{
      id: string;
      entityId: string | null;
      botToken: string | null;
      botUsername: string | null;
      offset: number | null;
    }>;
    try {
      rows = await deps.db
        .select({
          id: agents.id,
          entityId: agents.entityId,
          botToken: agents.telegramBotToken,
          botUsername: agents.telegramBotUsername,
          offset: agents.telegramOffset,
        })
        .from(agents)
        .where(and(isNotNull(agents.telegramBotToken), eq(agents.active, true)));
    } catch (err) {
      console.warn(
        `[telegram-manager] DB scan failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }

    const seen = new Set<string>();

    for (const row of rows) {
      if (!row.botToken || !row.entityId) continue;
      // The column is encrypted at rest; a row written before that migration
      // is still plaintext and passes through untouched. A row we CANNOT
      // decrypt (master key replaced / DB restored from another install) is
      // skipped with a named error instead of taking the whole manager down —
      // the other agents' pollers must keep running. Not adding it to `seen`
      // also despawns any poller still holding the stale token.
      let token: string;
      try {
        token = decryptChannelSecret(row.botToken, `telegram bot token (agent ${row.id})`);
      } catch (err) {
        console.error(
          `[telegram-manager agent=${row.id}] ${err instanceof Error ? err.message : String(err)}`,
        );
        continue;
      }
      seen.add(row.id);

      const existing = active.get(row.id);
      if (existing) {
        // Token rotated → restart the poller with the new token + fresh offset
        if (existing.botToken !== token) {
          existing.controller.abort();
          await existing.exit;
          spawn(row.id, row.entityId, token, row.botUsername, row.offset ?? 0);
        }
        continue;
      }

      spawn(row.id, row.entityId, token, row.botUsername, row.offset ?? 0);
    }

    // Stop pollers whose agent disappeared or had its token cleared
    for (const [agentId, poller] of active) {
      if (seen.has(agentId)) continue;
      poller.controller.abort();
      await poller.exit;
      active.delete(agentId);
    }
  }

  function spawn(
    agentId: string,
    agentEntityId: string,
    botToken: string,
    botUsername: string | null,
    startOffset: number,
  ): void {
    const controller = new AbortController();
    const exit = runTelegramPoller({
      agentId,
      agentEntityId,
      botToken,
      botUsername,
      startOffset,
      signal: controller.signal,
      deps,
      env: opts.env,
    })
      .catch((err) => {
        console.error(
          `[telegram-manager agent=${agentId}] poller crashed: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        return { reason: 'aborted', finalOffset: startOffset } satisfies PollerExit;
      })
      .finally(() => {
        // Self-cleanup: if the poller exited on its own (invalid_token),
        // remove it from the active map so a future refresh can respawn.
        if (active.get(agentId)?.controller === controller) {
          active.delete(agentId);
        }
      });

    active.set(agentId, { agentId, botToken, controller, exit });
  }

  async function tick(): Promise<void> {
    await refresh();
    if (!stopped) {
      timer = setTimeout(() => void tick(), refreshMs);
    }
  }

  // Initial load + scheduling
  void tick();

  return {
    async stop(): Promise<void> {
      if (stopped) return;
      stopped = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      const exits: Array<Promise<PollerExit>> = [];
      for (const [, poller] of active) {
        poller.controller.abort();
        exits.push(poller.exit);
      }
      await Promise.allSettled(exits);
      active.clear();
    },
    async refreshNow(): Promise<void> {
      await refresh();
    },
    activeCount(): number {
      return active.size;
    },
  };
}
