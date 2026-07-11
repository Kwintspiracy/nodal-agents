// registry.ts — resolve a ChannelAdapter by channel kind.
//
// Map-based on purpose: a caller (e.g. approvals/notify.ts, a future
// channel-neutral send path) asks for "the adapter for this job's channel"
// without knowing which channels exist. An unregistered channel is a
// programming/config error, not a recoverable delivery failure — fail loud
// rather than falling back to a default channel (invariant #4).

import { DeliveryError } from './errors.ts';
import { telegramAdapter } from './channels/telegram-adapter.ts';
import type { ChannelAdapter, ChannelKind } from './channel-adapter.ts';

const adapters: ReadonlyMap<ChannelKind, ChannelAdapter> = new Map([['telegram', telegramAdapter]]);

/** Resolve the ChannelAdapter for `channel`. Throws `channel_adapter_not_found`
 *  (never returns a default/best-guess adapter) when none is registered. */
export function getAdapter(channel: ChannelKind): ChannelAdapter {
  const adapter = adapters.get(channel);
  if (!adapter) {
    throw new DeliveryError(
      'channel_adapter_not_found',
      `channel_adapter_not_found: no ChannelAdapter registered for channel "${channel}"`,
    );
  }
  return adapter;
}
