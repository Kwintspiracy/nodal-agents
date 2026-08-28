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
import {
  describeError,
  errorIdentity,
  logRepeatingFailure,
  reportRepeatingRecovery,
  clearRepeatingFailure,
} from '../../lib/repeat-log.ts';
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
  /**
   * How many DB scans have completed. Test-only: it is the one observable
   * proof that a socket dying mid-scan gets a follow-up scan rather than
   * having its request swallowed by the single-flight guard — the follow-up
   * does not necessarily spawn anything (the backoff may hold it), so a spawn
   * count cannot tell the two apart.
   */
  _scanCountForTests(): number;
}

interface ActiveSocket {
  agentId: string;
  credentialsHash: string;
  /**
   * Null only for the instant between registering this entry and the socket
   * factory returning. The entry is registered FIRST so that a factory which
   * fires onConnected/onClosed synchronously (a fake in tests, and nothing
   * stops a real transport from doing it either) finds the state it needs — a
   * callback closing over the `const handle` would hit the temporal dead zone
   * and throw a ReferenceError, which the per-binding catch would swallow into
   * a plausible-looking recovery (found by codex review, PR #42).
   */
  handle: SlackSocketHandle | null;
  /**
   * The socket told us it is finished (start() rejected, or the websocket
   * closed for good — Bolt's own reconnect is off, see socket.ts's
   * slackReceiverOptions). A flag rather than deleting the map entry from the
   * callback: the callback can fire in the middle of a refresh, and mutating
   * the map underneath it raced. The next refresh reads the flag and respawns.
   */
  dead: boolean;
  /**
   * This socket reached a live connection at least once. Slack rotates
   * connections on its own (`refresh_requested`), which with Bolt's reconnect
   * disabled arrives here as a death — waiting up to 30s for the next scan to
   * replace an otherwise healthy ingress is a self-inflicted outage, so an
   * ESTABLISHED socket is replaced immediately. One that never connected stays
   * on the backoff path: retrying an invalid token instantly is how this
   * becomes an unbounded call rate against Slack.
   */
  connected: boolean;
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
  /**
   * A refresh was asked for while one was already running.
   *
   * The single-flight guard alone loses a request: an established socket that
   * dies AFTER its own row was processed by the in-flight scan collapses its
   * immediate-respawn call into that scan, which will never look at it again —
   * the dead socket then waits out the full 30s timer, missing messages,
   * despite the immediate respawn this manager promises (found by codex
   * review, PR #42). Remembering the request and running one more scan
   * afterwards closes that window without giving up single-flight.
   */
  let refreshQueued = false;
  let scanCount = 0;

  function refresh(): Promise<void> {
    if (inFlightRefresh) {
      refreshQueued = true;
      return inFlightRefresh;
    }
    const p = refreshInternal().finally(() => {
      inFlightRefresh = null;
      // Bounded: only a socket death sets this flag, and a death consumes the
      // socket that produced it — this cannot spin.
      if (refreshQueued && !stopped) {
        refreshQueued = false;
        void refresh();
      }
    });
    inFlightRefresh = p;
    return p;
  }

  async function refreshInternal(): Promise<void> {
    if (stopped) return;
    scanCount++;

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
        errorIdentity(err),
        () => `[slack-manager] DB scan failed: ${describeError(err)}`,
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
            // …and its collapsed-failure tally too. Otherwise an operator who
            // rotates a token after a run of failures, onto one that fails the
            // SAME way, has that first failure counted as a repeat of the old
            // credential's — silent until the 20th. Each credential opens its
            // own visible incident.
            clearRepeatingFailure(`slack-manager:socket:${row.agentId}`);
            await existing.handle?.stop();
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
            // Shut the dead one down BEFORE replacing it. A transport error
            // reports closure while the old client's close handshake and
            // timers may still be running: dropping the handle unstopped
            // leaves that client alive and unreachable — manager shutdown can
            // never reach it, and two clients can briefly coexist on one
            // binding (duplicate inbound events).
            await existing.handle?.stop();
            active.delete(row.agentId);
            spawnOne(row.agentId, row.entityId, hash, creds);
          } else if (existing.connected) {
            // CONNECTED and alive across a full refresh cycle — both halves
            // matter. Merely having connected once is not enough: a socket
            // that connects and dies immediately, over and over, would reset
            // the counter each round and spin in a hot respawn loop. And
            // surviving a refresh is not enough either: a start() still
            // PENDING across a refresh is neither dead nor connected, which is
            // the normal shape of a network outage (Slack's client retries
            // connection setup internally), and clearing the backoff there
            // restarted the throttle from zero every cycle — defeating it
            // exactly when it is needed (found by codex review, PR #42).
            retry.delete(row.agentId);
          }
          continue;
        }

        spawnOne(row.agentId, row.entityId, hash, creds);
      } catch (err) {
        console.error(
          `[slack-manager agent=${row.agentId}] refresh failed for this binding: ${describeError(
            err,
          )}`,
        );
        continue;
      }
    }

    // Despawn sockets whose binding disappeared, got disabled, or whose agent went inactive.
    for (const [agentId, sock] of active) {
      if (seen.has(agentId)) continue;
      await sock.handle?.stop();
      active.delete(agentId);
      // The retry penalty belongs to the binding, not to the agent id. Left
      // behind, it would be inherited by a binding reconfigured later — with a
      // brand new token — making its first failure wait out the DEAD one's
      // backoff, and it would grow this map without bound as agents come and
      // go (found by codex review, PR #42).
      retry.delete(agentId);
      // Same reasoning for the collapsed-failure state: left behind, a binding
      // recreated later and failing for the SAME reason would have its first
      // failure counted as a repeat and stay silent until the 20th — a new
      // incident opening in silence, which is what this must never do.
      clearRepeatingFailure(`slack-manager:socket:${agentId}`);
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
    // Registered BEFORE the factory runs — see ActiveSocket.handle.
    const entry: ActiveSocket = {
      agentId,
      credentialsHash,
      handle: null,
      dead: false,
      connected: false,
    };
    active.set(agentId, entry);

    let handle: SlackSocketHandle;
    try {
      handle = spawnSocket({
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
          // connection on the next tick. Compared by ENTRY, not by handle, so
          // this is correct even when called synchronously from the factory.
          const current = active.get(agentId);
          if (current !== entry) return;
          current.dead = true;
          const wasEstablished = current.connected;
          // One message per death, collapsed: a permanently invalid token dies
          // on every retry, and a line per attempt is the storm this whole
          // change exists to prevent. The identity is the reason, so a DIFFERENT
          // failure (auth error becoming a network error) still surfaces at once.
          logRepeatingFailure(
            `slack-manager:socket:${agentId}`,
            reason,
            (count) =>
              `[slack-manager agent=${agentId}] socket closed (${reason}); respawning ${
                wasEstablished ? 'now' : 'on a later refresh'
              } with freshly-read credentials (attempt ${count})`,
          );
          // A connection that WAS live is replaced at once; refresh() is
          // single-flight, so this coalesces with any scan already running.
          if (wasEstablished && !stopped) void refresh();
        },
        onConnected: () => {
          const current = active.get(agentId);
          if (current !== entry) return;
          current.connected = true;
          reportRepeatingRecovery(
            `slack-manager:socket:${agentId}`,
            (failures) =>
              `[slack-manager agent=${agentId}] socket connected after ${failures} failed attempt(s)`,
          );
        },
      });
    } catch (err) {
      // The entry is registered before the factory runs (so synchronous
      // lifecycle callbacks find their state). If construction throws, that
      // placeholder must not survive: with a null handle and dead:false every
      // later refresh would read it as a healthy socket and the agent would
      // stay offline until its credentials changed or the process restarted.
      // Removing it lets the very next refresh try again.
      active.delete(agentId);
      throw err;
    }
    entry.handle = handle;
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
      await Promise.allSettled([...active.values()].map((sock) => sock.handle?.stop()));
      active.clear();
    },
    async refreshNow(): Promise<void> {
      // Guarantee a scan that STARTED after this call. Plain `refresh()` would
      // hand back a scan already in flight — one that may have read the
      // bindings before the caller's change, so a caller that just disabled a
      // binding could observe it still running. Not hypothetical: adding the
      // queued-refresh path above made such a scan much more likely to be in
      // flight, and it broke an existing despawn test.
      if (inFlightRefresh) await inFlightRefresh;
      await refresh();
    },
    activeCount(): number {
      return active.size;
    },
    _scanCountForTests(): number {
      return scanCount;
    },
  };
}
