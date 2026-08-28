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
}

const DEFAULT_REFRESH_MS = 30_000;

export function startSlackManager(deps: RunnerDeps, opts: SlackManagerOpts): SlackManagerHandle {
  const refreshMs = opts.refreshIntervalMs ?? DEFAULT_REFRESH_MS;
  const spawnSocket = opts.startSocket ?? startSlackSocket;
  const active = new Map<string, ActiveSocket>();
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
      console.warn(
        `[slack-manager] DB scan failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }

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
          // Credentials rotated (either token changed inside the binding) → restart.
          if (existing.credentialsHash !== hash) {
            await existing.handle.stop();
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
    });
    active.set(agentId, { agentId, credentialsHash, handle });
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
