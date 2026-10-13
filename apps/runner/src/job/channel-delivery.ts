// channel-delivery.ts — where a job's reply goes (#649), the channels where it
// reaches the user only by a tool, and the facts the prompt states about them
// (#613).

import { defaultSendChannel, jobChatOn, textDeliveryOf } from '@nodal-agents/delivery';
import type { ChannelKind, JobChat } from '@nodal-agents/delivery';
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
 * - `channel` : la réponse part dans un chat, par l'outil d'envoi, seul
 *   chemin vers ce chat. Deux façons d'y arriver :
 *   1. la demande VIENT d'un chat (telegram, discord, slack) : son auteur n'a
 *      que ce chat, il ne lit jamais le résultat du job. Si aucun outil n'est
 *      armé, la garde le dit fort (`telegram_not_delivered`) : réussir en
 *      silence serait perdre la réponse (#4) ;
 *   2. son déclencheur a DÉSIGNÉ un chat (`chat_id` posé par une routine qui
 *      veut sa confirmation, un webhook, « Send via Telegram » du dashboard),
 *      son canal est enregistré (`designatedChatChannel`), et l'outil d'envoi
 *      de CE canal est ARMÉ pour ce job (le job le tient, l'agent a la
 *      credential de ce canal).
 * - `result` : sinon. La réponse est le résultat du job, rendu là d'où vient
 *   la demande — l'appelant MCP ou API le lit, le web l'affiche, les Runs le
 *   gardent. Un chat désigné qu'aucun outil armé n'atteint sur son canal (jeton
 *   retiré, liaison désactivée, outil hors liste), ou dont la plateforme n'est
 *   pas enregistrée, tombe ici : l'origine lit le
 *   résultat, et exiger un envoi impossible ferait échouer un travail fait
 *   sans que personne ne reçoive rien de plus (revue de #657, passe 1).
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

type ReplyJob = DeliveryJob & {
  parentJobId: string | null;
  /** `agent_jobs.chat_channel` : le canal sur lequel `chatId` a été résolu, ou null. */
  chatChannel: string | null;
};

/**
 * Le canal du chat que le DÉCLENCHEUR a désigné, tel qu'il a été enregistré —
 * jamais déduit des canaux actifs de l'agent (revue passe 2 de #657).
 *
 * `agent_jobs.chat_channel` le porte, et lui seul : tout écrivain pose le chat
 * par `designateChat` (packages/db, queries/designated-chat.ts), avec le canal
 * sur lequel il l'a résolu, ou NULL ; la migration 0143 a rempli les lignes
 * antérieures par la même règle. `undefined` : aucun chat désigné, une demande
 * qui VIENT d'un chat (son canal est `channel`), ou un chat dont personne ne
 * connaît la plateforme — le runner ne la devine pas.
 */
export function designatedChatChannel(job: {
  channel: string | null;
  chatId: string | null;
  chatChannel: string | null;
}): ChannelKind | undefined {
  if (job.chatId == null || TOOL_ONLY_DELIVERY_CHANNELS.has(job.channel ?? '')) return undefined;
  return (job.chatChannel as ChannelKind | null) ?? undefined;
}

interface ReplyInputs {
  job: ReplyJob;
  activeChannels: readonly ChannelKind[];
  /** Les outils que le job tient (sa liste finale) : un outil d'envoi hors liste n'est pas armé. */
  heldTools: ReadonlySet<string>;
}

/**
 * Le `telegram_chat_id` du bloc Job context : le chat du job S'IL a été résolu
 * sur Telegram (`jobChatOn`), rien sinon. Le champ porte le nom d'une
 * plateforme ; un chat Discord, ou un chat dont personne ne connaît la
 * plateforme, n'y est jamais présenté comme un chat Telegram (#649, revue
 * passe 4 de #657). Lu par les deux constructeurs du prompt (execute.ts,
 * cli-runtime/run-job.ts).
 */
export function telegramChatOf(chat: JobChat): { telegramChatId?: string } {
  const id = jobChatOn(chat, 'telegram');
  return id ? { telegramChatId: id } : {};
}

/** Le chat du job, avec le canal sur lequel il a été résolu — jamais l'un sans l'autre. */
function chatOf(job: ReplyJob): JobChat {
  return { id: job.chatId, channel: job.chatChannel };
}

export function replyDestination(opts: ReplyInputs): ReplyDestination {
  const { job } = opts;
  if (job.parentJobId) return { to: 'parent' };
  // La demande vient de ce chat : son auteur n'a que lui.
  if (TOOL_ONLY_DELIVERY_CHANNELS.has(job.channel ?? '')) {
    return { to: 'channel', channel: job.channel as ChannelKind };
  }
  // Un chat désigné par le déclencheur, atteint sur SON canal : l'outil qui
  // envoie sur ce canal est tenu ET l'agent a la credential de CE canal. Un
  // même nom d'outil sert telegram, discord et slack : le tenir ne dit rien du
  // canal qu'il peut atteindre, la credential le dit.
  const channel = designatedChatChannel(job);
  if (job.chatId == null || channel === undefined) return { to: 'result' };
  const sendTool = CHANNEL_SEND_TOOL[channel];
  const armed =
    sendTool !== undefined && opts.heldTools.has(sendTool) && opts.activeChannels.includes(channel);
  return armed ? { to: 'channel', channel } : { to: 'result' };
}

/**
 * Ce que le prompt dit du canal où l'outil d'envoi de ce job écrit — ou
 * `undefined` quand aucun outil d'envoi n'existe pour ce canal.
 *
 * Le canal et la cible sont ceux que l'outil calculera, par la MÊME règle
 * (`defaultSendChannel` puis `jobChatOn`, @nodal-agents/delivery — ce que
 * lit `resolveRecipientChatId`, delivery-guard.ts) : le canal du chat du job,
 * sinon `resolveTransportChannel` ; la cible, ce chat s'il a été résolu sur ce
 * canal, sinon la conversation propriétaire de ce canal (revue passe 4 de
 * #657 : la ligne annonçait le propriétaire quand l'outil visait le chat). `renders` est ce que l'adaptateur de CE canal
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
  const chat = chatOf(opts.job);
  const channel = defaultSendChannel(chat, opts.job.channel, opts.activeChannels);
  const sendTool = CHANNEL_SEND_TOOL[channel];
  if (sendTool === undefined) return undefined;
  return {
    channel,
    sendTool,
    renders: textDeliveryOf(channel).renders,
    reply: reply.to,
    target: jobChatOn(chat, channel) !== null ? 'chat' : 'owner',
  };
}
