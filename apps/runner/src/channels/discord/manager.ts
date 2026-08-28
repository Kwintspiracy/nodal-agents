// channels/discord/manager.ts — orchestrate one Discord gateway Client per
// configured channel_bindings row (channel='discord', enabled=true). Mirrors
// telegram/manager.ts's poll-the-DB-for-changes shape (KISS for MVT — see its
// file header for why polling beats pub/sub here).
//
// Lifecycle:
//   - On start: fetch every ENABLED discord binding for an ACTIVE agent, spawn
//     a gateway for each.
//   - Every `refreshIntervalMs` (default 30s): re-fetch, diff against running
//     gateways, start newcomers, respawn ones whose credentials rotated
//     (compared by credentialsFingerprint of the DECRYPTED credential bag —
//     never of the stored blob, whose AES-GCM IV changes on every write and
//     would read as a rotation on every single refresh), despawn
//     removed-or-disabled ones.
//   - On stop: destroy every gateway client and await their shutdown.

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
  renderError,
  logRepeatingFailure,
  reportRepeatingRecovery,
} from '../../lib/repeat-log.ts';
import {
  startDiscordGateway,
  type DiscordGatewayHandle,
  type DiscordGatewayOpts,
} from './gateway.ts';

export interface DiscordManagerOpts {
  env: RunnerEnv;
  /** How often to scan the DB for new/removed/rotated bindings. Default 30s. */
  refreshIntervalMs?: number;
  /** Injectable for tests — defaults to the real discord.js gateway (startDiscordGateway). */
  startGateway?: (opts: DiscordGatewayOpts) => DiscordGatewayHandle;
}

export interface DiscordManagerHandle {
  /** Stop refreshing + destroy every gateway client + await their shutdown. */
  stop(): Promise<void>;
  /** Force-refresh now (used by tests; production relies on the timer). */
  refreshNow(): Promise<void>;
  /** Number of gateways currently running (used by tests). */
  activeCount(): number;
}

interface ActiveGateway {
  agentId: string;
  credentialsHash: string;
  handle: DiscordGatewayHandle;
}

const DEFAULT_REFRESH_MS = 30_000;

export function startDiscordManager(
  deps: RunnerDeps,
  opts: DiscordManagerOpts,
): DiscordManagerHandle {
  const refreshMs = opts.refreshIntervalMs ?? DEFAULT_REFRESH_MS;
  const spawnGateway = opts.startGateway ?? startDiscordGateway;
  const active = new Map<string, ActiveGateway>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  // Single-flight lock: refreshInternal awaits getBindingCredentials (network-
  // adjacent DB work) between reading a row and mutating `active`, so a second
  // caller invoked while one refresh is still in flight (the constructor's
  // initial tick racing an explicit refreshNow() — always true for tests, and
  // possible in production if a caller ever added a manual trigger) must NOT
  // start its own independent scan — it would double-spawn the same binding's
  // gateway before either finishes. Instead it awaits the SAME in-flight
  // promise, guaranteeing the caller only ever observes a fully-settled state.
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
            eq(channelBindings.channel, 'discord'),
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
        'discord-manager:db-scan',
        errorIdentity(err),
        () => `[discord-manager] DB scan failed: ${renderError(err)}`,
      );
      return;
    }
    reportRepeatingRecovery(
      'discord-manager:db-scan',
      (failures) => `[discord-manager] DB scan recovered after ${failures} failed attempt(s)`,
    );

    const seen = new Set<string>();

    for (const row of rows) {
      if (!row.entityId) continue;
      // One failing agent (bad credential, a spawnOne throw, …) must not
      // reject the whole refresh — every other binding still needs its scan.
      // NOTE: `seen.add` happens only AFTER the credential reads back. A
      // binding we can no longer decrypt is deliberately left out, so the
      // despawn pass below tears down any gateway still holding the old
      // token: we cannot verify it is current, and running on a credential
      // the operator can no longer read is worse than being offline and loud.
      try {
        // Decrypt ONCE per row: the credential feeds both the rotation
        // fingerprint and the gateway itself. Fingerprinting the stored blob
        // would see a rotation on every refresh (fresh AES-GCM IV per write)
        // and respawn healthy gateways in a loop.
        const creds = await getBindingCredentials(deps.db, row.agentId, 'discord');
        if (!creds) {
          console.warn(
            `[discord-manager agent=${row.agentId}] binding has no readable credentials; skipping`,
          );
          continue;
        }
        seen.add(row.agentId);
        const hash = credentialsFingerprint(creds);

        const existing = active.get(row.agentId);
        if (existing) {
          // Credentials rotated (token changed inside the binding) → restart.
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
          `[discord-manager agent=${row.agentId}] refresh failed for this binding: ${describeError(
            err,
          )}`,
        );
        continue;
      }
    }

    // Despawn gateways whose binding disappeared, got disabled, or whose agent went inactive.
    for (const [agentId, gw] of active) {
      if (seen.has(agentId)) continue;
      await gw.handle.stop();
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
    if (!botToken) {
      console.warn(
        `[discord-manager agent=${agentId}] binding has no usable botToken credential; skipping ` +
          '(will retry on the next refresh once fixed)',
      );
      return;
    }
    const handle = spawnGateway({
      agentId,
      agentEntityId: entityId,
      botToken,
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
      await Promise.allSettled([...active.values()].map((gw) => gw.handle.stop()));
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
