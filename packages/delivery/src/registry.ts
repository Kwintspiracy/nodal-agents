// registry.ts — resolve a ChannelAdapter by channel kind.
//
// Map-based on purpose: a caller (e.g. approvals/notify.ts, a future
// channel-neutral send path) asks for "the adapter for this job's channel"
// without knowing which channels exist. An unregistered channel is a
// programming/config error, not a recoverable delivery failure — fail loud
// rather than falling back to a default channel (invariant #4).

import { DeliveryError } from './errors.ts';
import { telegramAdapter } from './channels/telegram-adapter.ts';
import { discordAdapter } from './channels/discord-adapter.ts';
import { slackAdapter } from './channels/slack-adapter.ts';
import { whatsappAdapter } from './channels/whatsapp-adapter.ts';
import type { ChannelAdapter, ChannelKind, TextDelivery } from './channel-adapter.ts';

const adapters: ReadonlyMap<ChannelKind, ChannelAdapter> = new Map([
  ['telegram', telegramAdapter],
  ['discord', discordAdapter],
  ['slack', slackAdapter],
  ['whatsapp', whatsappAdapter],
]);

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

/**
 * Ce que l'adaptateur de `channel` fait d'un texte (#613). Une LECTURE de sa
 * déclaration, jamais un envoi : le prompt d'un job la cite, et c'est ici
 * qu'elle se lit plutôt que par `getAdapter` chez l'appelant, où tout usage
 * se range parmi les envois (architecture du runner : un envoi terminal ne
 * part que par l'outbox).
 */
export function textDeliveryOf(channel: ChannelKind): TextDelivery {
  return getAdapter(channel).text;
}
