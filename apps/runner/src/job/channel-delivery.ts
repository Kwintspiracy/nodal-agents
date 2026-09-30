// channel-delivery.ts — where a job's reply goes (#649), the channels where it
// reaches the user only by a tool, and the facts the prompt states about them
// (#613).

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
 * Où va la RÉPONSE d'un job (#649) — une notion, calculée une fois par job,
 * lue par le prompt (`channelDeliveryFacts`) et par la garde de livraison
 * (execute.ts).
 *
 * - `parent` : un délégué répond à son parent ; le `chat_id` qu'il hérite ne
 *   fait pas de lui un interlocuteur (#559).
 * - `channel` : la demande porte un chat où répondre — elle en vient
 *   (telegram, discord, slack) ou son déclencheur l'a désigné (`chat_id` posé
 *   par une routine qui veut sa confirmation, un webhook, « Send via
 *   Telegram » du dashboard) —, et ce canal a un outil d'envoi : l'outil est
 *   le seul chemin de la réponse.
 * - `result` : sinon. La réponse est le résultat du job, rendu là d'où vient
 *   la demande — l'appelant MCP ou API le lit, le web l'affiche, les Runs le
 *   gardent.
 *
 * Le canal de REPLI (`resolveTransportChannel` d'une origine sans transport)
 * ne décide jamais de la destination : il sert aux messages que le
 * propriétaire doit recevoir sans les avoir demandés dans un chat (cartes
 * d'approbation, approvals/notify.ts ; envoi délibéré d'un outil, owner
 * fallback de delivery-guard.ts). L'y confondre envoyait la réponse d'une
 * demande MCP sur le Telegram du propriétaire (runs 06a4ab7d, 12f2972f).
 */
export type ReplyDestination =
  | { to: 'parent' }
  | { to: 'channel'; channel: ChannelKind }
  | { to: 'result' };

type ReplyJob = DeliveryJob & { parentJobId: string | null };

interface ReplyInputs {
  job: ReplyJob;
  notifyChannelOverride: ChannelKind | undefined;
  activeChannels: readonly ChannelKind[];
}

/**
 * Le canal que l'outil d'envoi de ce job résout quand l'agent n'en nomme pas
 * (`defaultChannelForJob`, delivery-guard.ts) : la cible choisie par la
 * routine, sinon `resolveTransportChannel`.
 */
function sendToolChannel(opts: ReplyInputs): ChannelKind {
  return (
    opts.notifyChannelOverride ?? resolveTransportChannel(opts.job.channel, opts.activeChannels)
  );
}

export function replyDestination(opts: ReplyInputs): ReplyDestination {
  const { job } = opts;
  if (job.parentJobId) return { to: 'parent' };
  const hasChat = TOOL_ONLY_DELIVERY_CHANNELS.has(job.channel ?? '') || job.chatId != null;
  const channel = sendToolChannel(opts);
  if (hasChat && TOOL_ONLY_DELIVERY_CHANNELS.has(channel)) return { to: 'channel', channel };
  return { to: 'result' };
}

/**
 * Ce que le prompt dit du canal où l'outil d'envoi de ce job écrit — ou
 * `undefined` quand aucun outil d'envoi n'existe pour ce canal.
 *
 * Le canal est celui que l'outil résoudra (`defaultChannelForJob`,
 * delivery-guard.ts) : la cible choisie par la routine, sinon
 * `resolveTransportChannel`. `renders` est ce que l'adaptateur de CE canal
 * déclare — pas une phrase par canal (invariants #1 et #2) : Telegram ne rend
 * aucune marque, Discord rend le markdown, Slack et WhatsApp leur balisage.
 * `reply` est la destination de la réponse (`replyDestination`, #649) : sur
 * `channel`, l'outil est le seul chemin vers l'utilisateur ; sur `result`
 * (un job MCP, API, du dashboard d'un agent qui a un bot), la réponse est le
 * résultat du job, l'outil n'envoie qu'un message séparé au propriétaire, et
 * le fait de format vaut encore pour ce message.
 *
 * L'orchestration ne rend la ligne que si le job détient `sendTool` (#559) :
 * un délégué qui hérite du `chat_id` sans l'outil n'en lit rien.
 *
 * Remplace la couche « Channel etiquette » (6 300 caractères écrits pour
 * Telegram, injectés aussi sur Discord et Slack), dont trois consignes
 * contredisaient le runner. Le découpage à la main qu'elle ordonnait a nourri
 * les 30 envois du 28/09.
 */
export function channelDeliveryFacts(
  opts: ReplyInputs,
  reply: ReplyDestination = replyDestination(opts),
): JobContext['channelDelivery'] {
  const channel = sendToolChannel(opts);
  const sendTool = CHANNEL_SEND_TOOL[channel];
  if (sendTool === undefined) return undefined;
  return {
    channel,
    sendTool,
    renders: textDeliveryOf(channel).renders,
    reply: reply.to,
  };
}
