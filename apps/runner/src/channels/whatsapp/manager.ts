// channels/whatsapp/manager.ts — orchestrate one Baileys socket (via
// ensureWhatsAppSocket, packages/delivery) per configured channel_bindings row
// (channel='whatsapp', enabled=true). Mirrors channels/discord/manager.ts's
// poll-the-DB-for-changes shape (see its file header for why polling beats
// pub/sub here), with one structural difference: WhatsApp has no separate
// "gateway" wrapper (gateway.ts/socket.ts) because the live Baileys socket IS
// both the outbound send path (whatsapp-adapter.ts) AND the inbound ingress —
// this module owns spawning + the inbound message wiring directly, and
// additionally owns PAIRING STATE (qr/status per agent), which the other
// channels have no equivalent of (a bot token needs no user-driven linking
// step; a WhatsApp session does).
//
// bindingKey for ensureWhatsAppSocket/closeWhatsAppSocket is the credential's
// OWN sessionDir — NOT the channel_bindings row id — because
// whatsapp-adapter.ts (the OUTBOUND send path) resolves the SAME singleton by
// keying on sessionDir too (see its file header). Keying by anything else
// here would open a SECOND live websocket for the same linked WhatsApp
// account: WhatsApp itself doesn't tolerate two concurrent sockets for one
// linked device (the newer connection knocks the older one offline) — so
// this MUST stay in lockstep with the adapter's own key choice.
//
// Lifecycle: identical to discord/slack — on start, spawn a socket per
// enabled binding on an active agent; every `refreshIntervalMs` (default
// 30s), re-fetch, diff, start newcomers, respawn rotated credentials, despawn
// removed-or-disabled ones; on stop, close every socket and await shutdown.
// Pairing state (qr/status) is NEVER persisted — module-scoped, in-memory
// only inside this handle, cleared the moment a binding despawns.

import { eq, and } from '@nodal-agents/db';
import {
  agents,
  channelBindings,
  channelAllowedConversations,
  getChannelBinding,
  getBindingCredentials,
  credentialsFingerprint,
} from '@nodal-agents/db';
import {
  ensureWhatsAppSocket,
  closeWhatsAppSocket,
  type WhatsAppHandle,
  type WhatsAppStatus,
  type WhatsAppInboundMessage,
} from '@nodal-agents/delivery';
import type { RunnerDeps } from '../../deps.ts';
import type { RunnerEnv } from '../../env.ts';
import { logRepeatingFailure, reportRepeatingRecovery } from '../../lib/repeat-log.ts';
import { handleWhatsAppMessage, triggerJobWorker, type WhatsAppHandleResult } from './handler.ts';

export interface WhatsAppManagerOpts {
  env: RunnerEnv;
  /** How often to scan the DB for new/removed/rotated bindings. Default 30s. */
  refreshIntervalMs?: number;
  /** Injectable for tests — defaults to the real ensureWhatsAppSocket (@nodal-agents/delivery). */
  ensureSocket?: (bindingKey: string, opts: { sessionDir: string }) => WhatsAppHandle;
  /** Injectable for tests — defaults to the real closeWhatsAppSocket (@nodal-agents/delivery). */
  closeSocket?: (bindingKey: string) => void;
}

export interface WhatsAppPairingState {
  status: WhatsAppStatus;
  /** Only ever non-null while status is 'qr_pending' — cleared the instant the socket moves past it. */
  qr: string | null;
}

export interface WhatsAppManagerHandle {
  /** Stop refreshing + close every socket + await their shutdown. */
  stop(): Promise<void>;
  /** Force-refresh now (used by tests; production relies on the timer). */
  refreshNow(): Promise<void>;
  /** Number of sockets currently running (used by tests). */
  activeCount(): number;
  /** Current pairing state for the agent's whatsapp binding, or null when
   *  none is tracked (never started / disabled / removed). */
  getPairingState(agentId: string): WhatsAppPairingState | null;
  /**
   * Idempotently ensure the socket for this agent's whatsapp binding is
   * created/connecting RIGHT NOW, rather than waiting up to
   * `refreshIntervalMs` for the next poll tick — the pairing route's POST
   * calls this so clicking "Connect" on the dashboard doesn't sit idle.
   * Returns 'no_binding' when the agent has no enabled whatsapp binding with
   * a usable sessionDir credential.
   */
  ensurePairingStarted(agentId: string): Promise<'started' | 'no_binding'>;
}

interface ActiveSocket {
  agentId: string;
  entityId: string;
  sessionDir: string;
  credentialsHash: string;
  handle: WhatsAppHandle;
}

const DEFAULT_REFRESH_MS = 30_000;

export function startWhatsAppManager(
  deps: RunnerDeps,
  opts: WhatsAppManagerOpts,
): WhatsAppManagerHandle {
  const refreshMs = opts.refreshIntervalMs ?? DEFAULT_REFRESH_MS;
  const ensureSocket = opts.ensureSocket ?? ensureWhatsAppSocket;
  const closeSocket = opts.closeSocket ?? closeWhatsAppSocket;
  const active = new Map<string, ActiveSocket>(); // keyed by agentId
  const pairing = new Map<string, WhatsAppPairingState>(); // keyed by agentId
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  // Single-flight lock — same race-fix as discord/slack managers: a second
  // caller invoked while one refresh is still in flight must await the SAME
  // in-flight promise instead of starting an independent scan.
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
            eq(channelBindings.channel, 'whatsapp'),
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
        'whatsapp-manager:db-scan',
        err instanceof Error ? err.message : String(err),
        () =>
          `[whatsapp-manager] DB scan failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }
    reportRepeatingRecovery(
      'whatsapp-manager:db-scan',
      (failures) => `[whatsapp-manager] DB scan recovered after ${failures} failed attempt(s)`,
    );

    const seen = new Set<string>();

    for (const row of rows) {
      if (!row.entityId) continue;
      // One failing agent (bad credential, a spawnOne throw, …) must not
      // reject the whole refresh — every other binding still needs its scan.
      // `seen.add` only after the credential reads back, same reasoning as
      // discord/manager.ts: a binding we cannot decrypt is despawned, loudly,
      // rather than left running on a credential nobody can verify.
      try {
        // The blob is encrypted at rest; decrypt ONCE and fingerprint the
        // PLAINTEXT. Hashing the stored value would see a rotation on every
        // refresh (fresh AES-GCM IV per write) and relink the WhatsApp socket
        // in a loop — which for this channel means knocking the linked device
        // offline repeatedly, not just a reconnect.
        const creds = await getBindingCredentials(deps.db, row.agentId, 'whatsapp');
        if (!creds) {
          console.warn(
            `[whatsapp-manager agent=${row.agentId}] binding has no readable credentials; skipping`,
          );
          continue;
        }
        seen.add(row.agentId);
        const hash = credentialsFingerprint(creds);

        const existing = active.get(row.agentId);
        if (existing) {
          // Credentials rotated (e.g. re-linked to a fresh sessionDir) → restart.
          if (existing.credentialsHash !== hash) {
            closeSocket(existing.sessionDir);
            active.delete(row.agentId);
            pairing.delete(row.agentId);
            spawnOne(row.agentId, row.entityId, creds, hash);
          }
          continue;
        }

        spawnOne(row.agentId, row.entityId, creds, hash);
      } catch (err) {
        console.error(
          `[whatsapp-manager agent=${row.agentId}] refresh failed for this binding: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        continue;
      }
    }

    // Despawn sockets whose binding disappeared, got disabled, or whose agent went inactive.
    for (const [agentId, sock] of active) {
      if (seen.has(agentId)) continue;
      closeSocket(sock.sessionDir);
      active.delete(agentId);
      pairing.delete(agentId);
    }
  }

  function spawnOne(
    agentId: string,
    entityId: string,
    creds: Record<string, string>,
    credentialsHash: string,
  ): void {
    const sessionDir = creds['sessionDir'] ?? null;
    if (!sessionDir) {
      console.warn(
        `[whatsapp-manager agent=${agentId}] binding has no usable sessionDir credential; ` +
          'skipping (will retry on the next refresh once fixed)',
      );
      return;
    }

    const handle = ensureSocket(sessionDir, { sessionDir });
    pairing.set(agentId, { status: handle.getStatus(), qr: null });

    handle.events.on('qr', (qr) => {
      pairing.set(agentId, { status: 'qr_pending', qr });
    });
    handle.events.on('status', (status) => {
      const priorQr = pairing.get(agentId)?.qr ?? null;
      pairing.set(agentId, { status, qr: status === 'open' ? null : priorQr });
    });
    handle.events.on('message', (message) => {
      void onMessage(agentId, message).catch((err) => {
        console.error(
          `[whatsapp-manager agent=${agentId}] unhandled error in onMessage: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      });
    });

    active.set(agentId, { agentId, entityId, sessionDir, credentialsHash, handle });
  }

  async function onMessage(agentId: string, message: WhatsAppInboundMessage): Promise<void> {
    const entry = active.get(agentId);
    if (!entry) return; // despawned between the event firing and this handler running

    let result: WhatsAppHandleResult;
    try {
      result = await deps.db.transaction((tx) =>
        handleWhatsAppMessage({
          message,
          receivingAgentId: agentId,
          receivingAgentEntityId: entry.entityId,
          tx: tx as unknown as RunnerDeps['db'],
        }),
      );
    } catch (err) {
      console.error(
        `[whatsapp-manager agent=${agentId}] message handling failed (conversation=${message.conversationId}): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return;
    }

    // Fire worker AFTER commit so we never wake a worker for a rolled-back job.
    if (result.jobId) {
      triggerJobWorker(result.jobId, opts.env);
    }

    // H-1: an unknown conversation asked for access. WhatsApp has NO buttons
    // (capabilities.buttons=false) — the owner gets a plain TEXT notice
    // pointing at the dashboard instead of an inline approve/deny card.
    // Best-effort with a safety net: if the notice can't be sent, delete the
    // pending row so a later message re-asks rather than leaving the
    // requester stuck in limbo.
    if (result.pendingAuth) {
      const pending = result.pendingAuth;
      await sendAuthNotice(agentId, pending).catch(async (err) => {
        console.warn(
          `[whatsapp-manager agent=${agentId}] auth-notice send failed for conversation ` +
            `${pending.requesterConversationId}: ${err instanceof Error ? err.message : String(err)}; ` +
            'clearing pending row',
        );
        await deps.db
          .delete(channelAllowedConversations)
          .where(eq(channelAllowedConversations.id, pending.conversationRowId))
          .catch(() => {});
      });
    }
  }

  /**
   * Send the owner a plain-text authorization notice (no buttons on
   * WhatsApp), and tell the requester their request is pending. The owner
   * notice is load-bearing — if it throws, the caller clears the pending row.
   * The requester note is best-effort and never blocks.
   */
  async function sendAuthNotice(
    agentId: string,
    pending: NonNullable<WhatsAppHandleResult['pendingAuth']>,
  ): Promise<void> {
    const entry = active.get(agentId);
    if (!entry) {
      throw new Error(`whatsapp socket for agent ${agentId} is no longer active`);
    }
    // CHANNEL-001: no owner yet — this request IS the owner claim, held pending
    // until a human approves it in the dashboard. Nobody to notify; tell the
    // claimant where the decision happens.
    if (pending.ownerConversationId === null) {
      await entry.handle
        .send(pending.requesterConversationId, {
          text:
            'Demande enregistrée. Ce numéro WhatsApp n’a pas encore de propriétaire : ouvrez ' +
            'le tableau de bord, onglet Channels de l’agent, et autorisez cette conversation ' +
            'pour en prendre le contrôle.',
        })
        .catch(() => {});
      return;
    }

    const target = pending.targetAgentName
      ? `souhaite parler à l'agent « ${pending.targetAgentName} » via ce numéro WhatsApp`
      : 'souhaite parler à ce numéro WhatsApp';
    await entry.handle.send(pending.ownerConversationId, {
      text:
        `👤 ${pending.requesterName} (${pending.requesterConversationId}) ${target}.\n` +
        `WhatsApp n'a pas de boutons intégrés ici — approuvez ou refusez cette demande depuis ` +
        'le tableau de bord (Canaux → WhatsApp).',
    });
    await entry.handle
      .send(pending.requesterConversationId, {
        text:
          'Votre demande a été transmise au propriétaire de ce numéro WhatsApp pour autorisation. ' +
          'Vous pourrez écrire dès qu’elle est acceptée.',
      })
      .catch(() => {});
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
      for (const sock of active.values()) {
        closeSocket(sock.sessionDir);
      }
      active.clear();
      pairing.clear();
    },
    async refreshNow(): Promise<void> {
      await refresh();
    },
    activeCount(): number {
      return active.size;
    },
    getPairingState(agentId: string): WhatsAppPairingState | null {
      return pairing.get(agentId) ?? null;
    },
    async ensurePairingStarted(agentId: string): Promise<'started' | 'no_binding'> {
      if (active.has(agentId)) return 'started';

      const binding = await getChannelBinding(deps.db, agentId, 'whatsapp');
      // A concurrent refresh() tick can have spawned this agent's socket
      // while the await above was in flight — re-check before doing more
      // async work, and again just before spawnOne below (M-2: two listener
      // sets on one shared Baileys handle means every inbound message fires
      // TWO jobs).
      if (active.has(agentId)) return 'started';
      if (!binding || !binding.enabled) return 'no_binding';

      const [agentRow] = await deps.db
        .select({ entityId: agents.entityId, active: agents.active })
        .from(agents)
        .where(eq(agents.id, agentId))
        .limit(1);
      if (!agentRow?.entityId || !agentRow.active) return 'no_binding';

      // Final re-check immediately before spawnOne — this is the ONLY await
      // gap that still matters at this point.
      if (active.has(agentId)) return 'started';

      // Same decrypt-then-fingerprint contract as refreshInternal above, so a
      // socket started from the dashboard's "Connect" and one started by the
      // poll tick agree on the hash and never respawn each other.
      const creds = await getBindingCredentials(deps.db, agentId, 'whatsapp');
      if (!creds) return 'no_binding';
      spawnOne(agentId, agentRow.entityId, creds, credentialsFingerprint(creds));
      return active.has(agentId) ? 'started' : 'no_binding';
    },
  };
}
