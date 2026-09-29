// channel-delivery.ts — the channels where a reply reaches the user only by a
// tool, and the facts the prompt states about them (#613).

import { resolveTransportChannel, textDeliveryOf } from '@nodal-agents/delivery';
import type { ChannelKind } from '@nodal-agents/delivery';
import type { JobContext } from '@nodal-agents/orchestration';
import { CHANNEL_SEND_TOOL } from './thread-history.ts';

// Channels whose ONLY path to the user is a delivery tool call (telegram_send_message,
// which dispatches through the job's own ChannelAdapter — see CHANNEL_SEND_TOOL in
// thread-history.ts). For these, a job that completes without ever delivering is a
// silent black hole — the delivery guard re-prompts the agent before letting such a
// job finish. Other channels (api, dashboard, cron, internal, …) expose agent_jobs.result
// directly, so a text-only completion is fine there.
// Live incident: job 4eefb5bf (2026-07-12) completed on discord with tools_used=[] —
// the guard already existed but only listed 'telegram', so a discord job's plain-text
// reply silently never reached the channel. discord/slack register the SAME send tools
// as telegram (gate at the capabilityTools.push call in execute.ts keys off
// deliveryBotToken || hasDiscordBinding || hasSlackBinding), so they belong in this set
// too. whatsapp does NOT: hasWhatsappBinding is not part of that gate yet (no outbound
// send tool is registered for a whatsapp job today), so adding it here would nudge the
// agent to call a tool it doesn't have — join it once whatsapp's outbound tooling ships.
export const TOOL_ONLY_DELIVERY_CHANNELS: ReadonlySet<string> = new Set([
  'telegram',
  'discord',
  'slack',
]);

type DeliveryJob = { channel: string | null; chatId: string | null };

/**
 * A cron or webhook job that carries a chatId opted into a success
 * confirmation (the cron tick / webhook route — routes/webhook.ts — only set
 * chat_id when the trigger's notify_on_success is on).
 */
export function triggerWantsConfirmation(job: DeliveryJob): boolean {
  return (job.channel === 'cron' || job.channel === 'webhook') && job.chatId != null;
}

/**
 * The job must deliver through a tool before it completes: a tool-only
 * channel, or a routine that asked for its confirmation. The delivery guard
 * (execute.ts) and the prompt's channel line read this one rule.
 */
export function requiresToolDelivery(job: DeliveryJob): boolean {
  return TOOL_ONLY_DELIVERY_CHANNELS.has(job.channel ?? '') || triggerWantsConfirmation(job);
}

/**
 * Ce que le prompt dit du canal où l'outil d'envoi de ce job écrit — ou
 * `undefined` quand aucun outil d'envoi n'existe pour ce canal.
 *
 * Le canal est celui que l'outil résoudra (`defaultChannelForJob`,
 * delivery-guard.ts) : la cible choisie par la routine, sinon
 * `resolveTransportChannel`. `shownAs` est ce que l'adaptateur de CE canal
 * déclare — pas une phrase par canal (invariants #1 et #2) : Telegram affiche
 * le texte brut, Discord rend le markdown. `onlyPath` est la condition de la
 * garde de livraison (`requiresToolDelivery`) : là, l'outil est le seul
 * chemin vers l'utilisateur. Ailleurs (un job du dashboard d'un agent qui a
 * un bot), l'outil existe et le fait de format vaut encore.
 *
 * L'orchestration ne rend la ligne que si le job détient `sendTool` (#559) :
 * un délégué qui hérite du `chat_id` sans l'outil n'en lit rien.
 *
 * Remplace la couche « Channel etiquette » (6 300 caractères écrits pour
 * Telegram, injectés aussi sur Discord et Slack), dont trois consignes
 * contredisaient le runner. Le découpage à la main qu'elle ordonnait a nourri
 * les 30 envois du 28/09.
 */
export function channelDeliveryFacts(opts: {
  job: DeliveryJob;
  notifyChannelOverride: ChannelKind | undefined;
  activeChannels: readonly ChannelKind[];
}): JobContext['channelDelivery'] {
  const { job } = opts;
  const channel =
    opts.notifyChannelOverride ?? resolveTransportChannel(job.channel, opts.activeChannels);
  const sendTool = CHANNEL_SEND_TOOL[channel];
  if (sendTool === undefined) return undefined;
  return {
    channel,
    sendTool,
    shownAs: textDeliveryOf(channel).shownAs,
    onlyPath: requiresToolDelivery(job),
  };
}
