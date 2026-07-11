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
//     (compared by a hash of the raw credentials string, since the token
//     itself lives inside that JSON blob), despawn removed-or-disabled ones.
//   - On stop: destroy every gateway client and await their shutdown.

import { createHash } from 'node:crypto';
import { eq, and } from '@nodal-agents/db';
import { agents, channelBindings, getBindingCredentials } from '@nodal-agents/db';
import type { RunnerDeps } from '../../deps.ts';
import type { RunnerEnv } from '../../env.ts';
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

function hashCredentials(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

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
      console.warn(
        `[discord-manager] DB scan failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }

    const seen = new Set<string>();

    for (const row of rows) {
      if (!row.entityId) continue;
      seen.add(row.agentId);
      const hash = hashCredentials(row.credentials);

      const existing = active.get(row.agentId);
      if (existing) {
        // Credentials rotated (token changed inside the binding) → restart.
        if (existing.credentialsHash !== hash) {
          await existing.handle.stop();
          active.delete(row.agentId);
          await spawnOne(row.agentId, row.entityId, hash);
        }
        continue;
      }

      await spawnOne(row.agentId, row.entityId, hash);
    }

    // Despawn gateways whose binding disappeared, got disabled, or whose agent went inactive.
    for (const [agentId, gw] of active) {
      if (seen.has(agentId)) continue;
      await gw.handle.stop();
      active.delete(agentId);
    }
  }

  async function spawnOne(
    agentId: string,
    entityId: string,
    credentialsHash: string,
  ): Promise<void> {
    const creds = await getBindingCredentials(deps.db, agentId, 'discord');
    const botToken = creds?.['botToken'];
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
