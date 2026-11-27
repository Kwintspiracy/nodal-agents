// link-state.ts — a messaging channel's link to its platform, as a connection
// state (connection-state.ts in @nodal-agents/shared). The one mapping for
// every channel: its manager reports what its link learnt, here.
//
// By the delivery package's own typed codes, never by platform: a
// `DeliveryError` whose code says the platform refused the token
// (`<channel>_invalid_token`, `<channel>_unauthorized`) or that the account is
// not linked (`<channel>_not_paired`) needs the person; any other failure is
// the platform being unreachable, retried by the manager.

import { DeliveryError } from '@nodal-agents/delivery';
import { recordConnectionState, type AnyDrizzleDb } from '@nodal-agents/db';
import {
  UNREACHABLE_RETRY_MS,
  channelConnectionId,
  connectionState,
  networkFailure,
  type ConnectionState,
} from '@nodal-agents/shared';

const REFUSED = /_(invalid_token|unauthorized|not_paired)$/;

export function channelLinkFailure(err: unknown, now: Date = new Date()): ConnectionState {
  const detail = err instanceof Error ? err.message : String(err);
  if (err instanceof DeliveryError && REFUSED.test(err.code)) {
    return connectionState('needs_reauth', 'grant_refused', detail, now);
  }
  return (
    networkFailure(err, now) ??
    connectionState(
      'unreachable',
      'provider_unavailable',
      detail,
      now,
      new Date(now.getTime() + UNREACHABLE_RETRY_MS),
    )
  );
}

/**
 * Record what a channel's link learnt: `null` for a link that works, the
 * error for one that failed. Logged, never thrown: a manager's loop must not
 * stop because the state could not be written.
 */
export async function recordChannelLink(
  db: AnyDrizzleDb,
  agentId: string,
  channel: string,
  failure: unknown | null,
): Promise<void> {
  const state: ConnectionState =
    failure === null ? connectionState('working', 'succeeded', null) : channelLinkFailure(failure);
  try {
    await recordConnectionState(
      db,
      { kind: 'channel', id: channelConnectionId(agentId, channel) },
      state,
    );
  } catch (err) {
    console.error(
      `[channel-link] recording '${state.state}' for ${channel} of agent ${agentId} failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}
