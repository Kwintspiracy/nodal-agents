// link-state.ts — a messaging channel's link to its platform, as a connection
// state (connection-state.ts in @nodal-agents/shared). The one vocabulary and
// the one writer for every channel.
//
// Each channel's manager knows how ITS library reports a link: it translates
// that typed signal (a close code, an error code, a disconnect reason) into a
// `ChannelLinkSignal`, next to where it learns it, and records it here. What a
// signal means is decided here, once, for every channel:
//
//   up             the link works                          → working
//   refused        the platform refused the token or the
//                  session for good                        → needs_reauth (grant_refused)
//   missing_right  a right the bot needs is not granted
//                  on the platform                         → needs_reauth (rights_missing)
//   misconfigured  the bot's configuration cannot connect  → broken (config_incomplete)
//   lost           lost for now; reconnected by the
//                  library or the manager                  → unreachable, with a retry time
//
// A channel whose manager records nothing is caught by
// channel-link-state.arch.test.ts: every channel of CHANNELS writes its state.

import { DeliveryError } from '@nodal-agents/delivery';
import { recordConnectionState, type AnyDrizzleDb } from '@nodal-agents/db';
import {
  UNREACHABLE_RETRY_MS,
  channelConnectionId,
  connectionState,
  type ConnectionState,
} from '@nodal-agents/shared';

export type ChannelLinkSignal =
  | { link: 'up' }
  | { link: 'refused' | 'missing_right' | 'misconfigured' | 'lost'; detail: string };

/** The state a channel's link signal puts the link in. */
export function channelLinkState(
  signal: ChannelLinkSignal,
  now: Date = new Date(),
): ConnectionState {
  switch (signal.link) {
    case 'up':
      return connectionState('working', 'succeeded', null, now);
    case 'refused':
      return connectionState('needs_reauth', 'grant_refused', signal.detail, now);
    case 'missing_right':
      return connectionState('needs_reauth', 'rights_missing', signal.detail, now);
    case 'misconfigured':
      return connectionState('broken', 'config_incomplete', signal.detail, now);
    case 'lost':
      return connectionState(
        'unreachable',
        'provider_unavailable',
        signal.detail,
        now,
        new Date(now.getTime() + UNREACHABLE_RETRY_MS),
      );
  }
}

const REFUSED_DELIVERY_CODE = /_(invalid_token|unauthorized|not_paired)$/;

/**
 * The signal a delivery-package error carries: its typed code says when the
 * platform refused the token (`<channel>_invalid_token`, `_unauthorized`) or
 * the account is not linked (`_not_paired`); any other failure is the link
 * lost for now.
 */
export function deliveryLinkSignal(err: unknown): ChannelLinkSignal {
  const detail = err instanceof Error ? err.message : String(err);
  if (err instanceof DeliveryError && REFUSED_DELIVERY_CODE.test(err.code)) {
    return { link: 'refused', detail };
  }
  return { link: 'lost', detail };
}

/**
 * Record what a channel's link learnt. Logged, never thrown: a manager's loop
 * must not stop because the state could not be written.
 */
export async function recordChannelLink(
  db: AnyDrizzleDb,
  agentId: string,
  channel: string,
  signal: ChannelLinkSignal,
): Promise<void> {
  const state = channelLinkState(signal);
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
