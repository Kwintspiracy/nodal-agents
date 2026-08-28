// channels/slack/manager.ts — orchestrate one Slack Socket Mode App per
// configured channel_bindings row (channel='slack', enabled=true). Mirrors
// channels/discord/manager.ts's poll-the-DB-for-changes shape exactly (see
// its file header for why polling beats pub/sub here) — the only structural
// difference is that Slack's Socket Mode needs TWO credentials (`botToken`
// AND `appToken`, the app-level token that opens the websocket) instead of
// Discord's one, so spawnOne below reads both and skips the binding if
// either is missing.
//
// Lifecycle: identical to discord/manager.ts — on start, spawn a socket per
// enabled binding on an active agent; every `refreshIntervalMs` (default
// 30s), re-fetch, diff, start newcomers, respawn rotated credentials, despawn
// removed-or-disabled ones; on stop, disconnect every socket and await
// shutdown.

import { eq, and } from '@nodal-agents/db';
import {
  agents,
  channelBindings,
  getBindingCredentials,
  credentialsFingerprint,
} from '@nodal-agents/db';
import type { RunnerDeps } from '../../deps.ts';
import type { RunnerEnv } from '../../env.ts';
import { logRepeatingFailure, reportRepeatingRecovery } from '../../lib/repeat-log.ts';
import { startSlackSocket, type SlackSocketHandle, type SlackSocketOpts } from './socket.ts';

export interface SlackManagerOpts {
  env: RunnerEnv;
  /** How often to scan the DB for new/removed/rotated bindings. Default 30s. */
  refreshIntervalMs?: number;
  /** Injectable for tests — defaults to the real @slack/bolt socket (startSlackSocket). */
  startSocket?: (opts: SlackSocketOpts) => SlackSocketHandle;
}

export interface SlackManagerHandle {
  /** Stop refreshing + disconnect every socket + await their shutdown. */
  stop(): Promise<void>;
  /** Force-refresh now (used by tests; production relies on the timer). */
  refreshNow(): Promise<void>;
  /** Number of sockets currently running (used by tests). */
  activeCount(): number;
}

interface ActiveSocket {
  agentId: string;
  credentialsHash: string;
  handle: SlackSocketHandle;
  /**
   * The socket told us it is finished (start() rejected, or the websocket
   * closed for good — Bolt's own reconnect is off, see socket.ts's
   * slackReceiverOptions). A flag rather than deleting the map entry from the
   * callback: the callback can fire in the middle of a refresh, and mutating
   * the map underneath it raced. The next refresh reads the flag and respawns.
   */
  dead: boolean;
}

const DEFAULT_REFRESH_MS = 30_000;

/**
 * How many refreshes to skip before retrying a binding that keeps failing,
 * indexed by consecutive failure count (capped at the last entry).
 *
 * Respawning a dead socket fixed an agent that stayed silently offline — but a
 * credential that is invalid FOREVER would then be retried on every 30s
 * refresh, each attempt writing a line and calling Slack again: one log storm
 * traded for another, plus an unbounded API call rate against a bot that will
 * never authenticate (found by codex review, PR #42). At a 30s refresh this
 * walks out to ~16 minutes between attempts, so a token fixed later is still
 * picked up on its own, just not hammered in the meantime.
 */
const RETRY_BACKOFF_REFRESHES = [0, 1, 3, 7, 15, 31];

function backoffFor(consecutiveFailures: number): number {
  const idx = Math.min(consecutiveFailures, RETRY_BACKOFF_REFRESHES.length - 1);
  return RETRY_BACKOFF_REFRESHES[idx] ?? 31;
}

export function startSlackManager(deps: RunnerDeps, opts: SlackManagerOpts): SlackManagerHandle {
  const refreshMs = opts.refreshIntervalMs ?? DEFAULT_REFRESH_MS;
  const spawnSocket = opts.startSocket ?? startSlackSocket;
  const active = new Map<string, ActiveSocket>();
  // Consecutive spawn failures per agent, and how many refreshes still to skip
  // before the next attempt. Cleared the moment a socket actually connects.
  const retry = new Map<string, { consecutiveFailures: number; refreshesToWait: number }>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  // Single-flight lock — same race-fix as discord/manager.ts: a second caller
  // invoked while one refresh is still in flight must await the SAME in-flight
  // promise instead of starting an independent scan (which would double-spawn
  // a socket before either finishes).
  let inFlightRefresh: Promise<void> | null = null;

  function refresh(): Promise<void> {
    if (inFlightRefresh) return inFlightRefresh;
    const p = refreshInternal().finally(() => {
      inFlightRefresh = null;
    });
    inFlightRefresh = p;
    return p;
  }

  async function refreshInternal(): Promise<void> {
    if (stopped) return;

    let rows: Array<{ agentId: string; entityId: string | null; credentials: string }>;
    try {
      rows = await deps.db
        .select({
          agentId: channelBindings.agentId,
          entityId: agents.entityId,
          credentials: channelBindings.credentials,
        })
        .from(channelBindings)
        .innerJoin(agents, eq(agents.id, channelBindings.agentId))
        .where(
          and(
            eq(channelBindings.channel, 'slack'),
            eq(channelBindings.enabled, true),
            eq(agents.active, true),
          ),
        );
    } catch (err) {
      // The scan runs every 30s. With the database gone it fails forever, and
      // five managers each logging it per tick is what buried a real
      // runner.log (see lib/repeat-log.ts). First failure in full, then a
      // count.
      logRepeatingFailure(
        'slack-manager:db-scan',
        err instanceof Error ? err.message : String(err),
        () => `[slack-manager] DB scan failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }
    reportRepeatingRecovery(
      'slack-manager:db-scan',
      (failures) => `[slack-manager] DB scan recovered after ${failures} failed attempt(s)`,
    );

    const seen = new Set<string>();

    for (const row of rows) {
      if (!row.entityId) continue;
      // One failing binding (undecryptable credential, a spawnOne throw, …)
      // must not reject the whole refresh — every other agent still needs its
      // scan, and an escaping rejection here surfaced as a process-level
      // `unhandledRejection` rather than a handled failure. discord/manager.ts
      // has had this guard since its ingress brique; slack never got it.
      try {
        // Decrypt ONCE per row: the credential feeds both the rotation
        // fingerprint and the socket itself. Fingerprinting the stored blob
        // would see a rotation on every refresh (fresh AES-GCM IV per write)
        // and respawn healthy sockets in a loop.
        const creds = await getBindingCredentials(deps.db, row.agentId, 'slack');
        if (!creds) {
          console.warn(
            `[slack-manager agent=${row.agentId}] binding has no readable credentials; skipping`,
          );
          continue;
        }
        seen.add(row.agentId);
        const hash = credentialsFingerprint(creds);

        const existing = active.get(row.agentId);
        if (existing) {
          // Respawn on either of two conditions:
          //   - the credentials rotated (a genuinely different token), or
          //   - the socket reported itself dead. Before this, a socket whose
          //     start() failed or whose websocket closed stayed registered
          //     forever and the agent was silently offline — the manager only
          //     ever looked at the credential.
          const rotated = existing.credentialsHash !== hash;
          if (rotated) {
            // A new credential is a fresh start: clear any backoff earned by
            // the old one, which is exactly the operator fixing the problem.
            retry.delete(row.agentId);
            await existing.handle.stop();
            active.delete(row.agentId);
            spawnOne(row.agentId, row.entityId, hash, creds);
            continue;
          }
          if (existing.dead) {
            const state = retry.get(row.agentId) ?? { consecutiveFailures: 0, refreshesToWait: 0 };
            if (state.refreshesToWait > 0) {
              state.refreshesToWait--;
              retry.set(row.agentId, state);
              continue;
            }
            state.consecutiveFailures++;
            state.refreshesToWait = backoffFor(state.consecutiveFailures);
            retry.set(row.agentId, state);
            active.delete(row.agentId);
            spawnOne(row.agentId, row.entityId, hash, creds);
          }
          continue;
        }

        spawnOne(row.agentId, row.entityId, hash, creds);
      } catch (err) {
        console.error(
          `[slack-manager agent=${row.agentId}] refresh failed for this binding: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        continue;
      }
    }

    // Despawn sockets whose binding disappeared, got disabled, or whose agent went inactive.
    for (const [agentId, sock] of active) {
      if (seen.has(agentId)) continue;
      await sock.handle.stop();
      active.delete(agentId);
    }
  }

  function spawnOne(
    agentId: string,
    entityId: string,
    credentialsHash: string,
    creds: Record<string, string>,
  ): void {
    const botToken = creds['botToken'];
    const appToken = creds['appToken'];
    if (!botToken || !appToken) {
      console.warn(
        `[slack-manager agent=${agentId}] binding has no usable botToken/appToken credential ` +
          'pair; skipping (will retry on the next refresh once fixed)',
      );
      return;
    }
    const handle = spawnSocket({
      agentId,
      agentEntityId: entityId,
      botToken,
      appToken,
      deps,
      env: opts.env,
      onClosed: (reason) => {
        // Only mark THIS socket dead: by the time the callback fires the map
        // may already hold a newer socket for the same agent (a rotation
        // respawned it), and flagging that one would tear down a healthy
        // connection on the next tick.
        const current = active.get(agentId);
        if (current?.handle !== handle) return;
        current.dead = true;
        // One message per death, collapsed: a permanently invalid token dies
        // on every retry, and a line per attempt is the storm this whole
        // change exists to prevent. The identity is the reason, so a DIFFERENT
        // failure (auth error becoming a network error) still surfaces at once.
        logRepeatingFailure(
          `slack-manager:socket:${agentId}`,
          reason,
          (count) =>
            `[slack-manager agent=${agentId}] socket closed (${reason}); respawning on a later ` +
            `refresh with freshly-read credentials (attempt ${count})`,
        );
      },
      onConnected: () => {
        const current = active.get(agentId);
        if (current?.handle !== handle) return;
        retry.delete(agentId);
        reportRepeatingRecovery(
          `slack-manager:socket:${agentId}`,
          (failures) =>
            `[slack-manager agent=${agentId}] socket connected after ${failures} failed attempt(s)`,
        );
      },
    });
    active.set(agentId, { agentId, credentialsHash, handle, dead: false });
  }

  async function tick(): Promise<void> {
    await refresh();
    if (!stopped) {
      timer = setTimeout(() => void tick(), refreshMs);
    }
  }

  void tick();

  return {
    async stop(): Promise<void> {
      if (stopped) return;
      stopped = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      await Promise.allSettled([...active.values()].map((sock) => sock.handle.stop()));
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
