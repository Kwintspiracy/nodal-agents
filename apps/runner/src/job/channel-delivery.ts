// channel-delivery.ts — where a job's reply goes (#649), and the facts the
// prompt states about the channel its send tool writes on (#613).
//
// A reply that goes to a chat is SENT BY THE HARNESS, on every channel
// (#1215, job/answer-delivery.ts): the gate that writes `completed` prepares
// it through the outbox. No channel is one where only a tool reaches the
// person any more; the send tools are for what is deliberately extra (a file,
// another chat, a progress note).

import {
  defaultSendChannel,
  isMessagingChannel,
  jobChatOn,
  textDeliveryOf,
} from '@nodal-agents/delivery';
import type { ChannelKind, JobChat } from '@nodal-agents/delivery';
import { conversationHandleFor } from '@nodal-agents/db';
import type { AnyDrizzleDb } from '@nodal-agents/db';
import type { JobContext } from '@nodal-agents/orchestration';

/**
 * Map of channel → the tool that sends a text on it.
 * An answer the agent sent itself lives inside a `*_send_message` tool call
 * rather than in `return_result`: the thread history reads it there, and
 * replays it in that form (thread-history.ts). Without this lookup we lose
 * the user-visible reply and the next turn's session-memory context comes
 * back empty.
 *
 * S3 (multichannel plan): exported so a later phase can extend this map
 * per-channel once other channels get their OWN send tool name. Here, and read
 * by the thread history (thread-history.ts) from here: the job's state machine
 * reads where a job's notice goes through this module, and the thread history
 * reads the state machine.
 *
 * WhatsApp est dans CONVERSATIONAL_CHANNELS et VOLONTAIREMENT absent d'ici : il
 * n'a pas d'outil d'envoi à lui, et les noms des outils de livraison ne
 * changeront qu'à cette phase-là. Un tour WhatsApp est donc relu sous la forme
 * TEXTE à deux messages, pas sous la forme appel d'outil à trois — poser ici un
 * nom d'outil qui n'existe pas apprendrait au modèle à appeler le vide.
 * (Le commentaire disait l'inverse jusqu'au 06/09 : il affirmait que WhatsApp
 * était dans l'ensemble au-dessus, ce qui était faux — revue Codex, passe 28.)
 *
 * Discord/Slack ingress (D2, K2): a discord or slack job's send tool IS
 * 'telegram_send_message' — the 6 delivery tools are registered by
 * CREDENTIAL AVAILABILITY, not by channel-specific name (see execute.ts's
 * capabilityTools gating and delivery-guard.ts's
 * resolveChannelForJob/resolveBotToken), and the tool itself already
 * dispatches through the channel-neutral ChannelAdapter resolved from the
 * job's OWN channel. Reusing the telegram-named tool for a discord/slack job
 * is functionally correct but semantically odd — renaming the 6 tools to
 * channel-neutral names (e.g. `send_message`) is cleanup-phase work, not
 * this ticket.
 */
export const CHANNEL_SEND_TOOL: Readonly<Record<string, string>> = {
  telegram: 'telegram_send_message',
  discord: 'telegram_send_message',
  slack: 'telegram_send_message',
};

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
 * lue par le prompt (`channelDeliveryFacts`, la ligne `delivery:` et
 * `notify_on_success`). La réponse elle-même est préparée par la porte qui
 * pose `completed`, d'après la ligne du job (`resolveDeliveryTarget`,
 * job/answer-delivery.ts) : ce fait-ci dit au modèle la même chose.
 *
 * - `parent` : un délégué répond à son parent ; le `chat_id` qu'il hérite ne
 *   fait pas de lui un interlocuteur (#559).
 * - `channel` : la réponse part dans un chat, envoyée par le harnais. Deux
 *   façons d'y arriver :
 *   1. la demande VIENT d'un chat (telegram, whatsapp, discord, slack) : son
 *      auteur n'a que ce chat, il ne lit jamais le résultat du job ;
 *   2. son déclencheur a DÉSIGNÉ un chat (`chat_id` posé par une routine qui
 *      veut sa confirmation, un webhook, « Send via Telegram » du dashboard),
 *      et son canal est enregistré (`designatedChatChannel`), et l'agent est
 *      connecté à ce canal.
 * - `result` : sinon. La réponse est le résultat du job, rendu là d'où vient
 *   la demande — l'appelant MCP ou API le lit, le web l'affiche, les Runs le
 *   gardent. Un chat désigné que l'agent n'atteint pas sur son canal (jeton
 *   retiré, liaison désactivée), ou dont la plateforme n'est pas enregistrée,
 *   tombe ici ; la porte, elle, le dit sur la ligne du job.
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
  if (job.chatId == null || isMessagingChannel(job.channel)) return undefined;
  return (job.chatChannel as ChannelKind | null) ?? undefined;
}

interface ReplyInputs {
  job: ReplyJob;
  activeChannels: readonly ChannelKind[];
}

/**
 * Le `telegram_chat_id` du bloc Job context : le chat du job S'IL a été résolu
 * sur Telegram (`jobChatOn`), rien sinon. Le champ porte le nom d'une
 * plateforme ; un chat Discord, ou un chat dont personne ne connaît la
 * plateforme, n'y est jamais présenté comme un chat Telegram (#649, revue
 * passe 4 de #657). Lu par les deux constructeurs du prompt (execute.ts,
 * cli-runtime/run-job.ts).
 *
 * Sa VALEUR est le handle de ce chat, jamais son identifiant Telegram (#824) :
 * le modèle ne lit une conversation que par son handle, et les outils d'envoi
 * le reprennent tel quel. La CLÉ reste `telegram_chat_id` : la skill Obsidian
 * du catalogue et les prompts d'agents stockés en base la lisent par son nom,
 * pour sa présence, et ne lisent jamais sa forme.
 */
export async function telegramChatOf(
  db: AnyDrizzleDb,
  entityId: string | null,
  chat: JobChat,
): Promise<{ telegramChatId?: string }> {
  if (jobChatOn(chat, 'telegram') === null) return {};
  const handle = await jobChatForModel(db, entityId, chat);
  return handle ? { telegramChatId: handle } : {};
}

/**
 * L'adresse du chat d'un job telle qu'un MODÈLE la lit (#824) : le handle de
 * ce chat sur le canal où il a été résolu, ou `null` quand le job n'a pas de
 * chat — ou un chat dont personne ne connaît la plateforme : sans canal, il
 * n'y a pas d'adresse, et aucun outil d'envoi ne l'atteint (`jobChatOn`).
 */
export async function jobChatForModel(
  db: AnyDrizzleDb,
  entityId: string | null,
  chat: JobChat,
): Promise<string | null> {
  if (!chat.id || !chat.channel) return null;
  return conversationHandleFor(db, {
    entityId,
    channel: chat.channel,
    conversationId: chat.id,
  });
}

/** Le chat du job, avec le canal sur lequel il a été résolu — jamais l'un sans l'autre. */
function chatOf(job: ReplyJob): JobChat {
  return { id: job.chatId, channel: job.chatChannel };
}

export function replyDestination(opts: ReplyInputs): ReplyDestination {
  const { job } = opts;
  if (job.parentJobId) return { to: 'parent' };
  // La demande vient de ce chat : son auteur n'a que lui.
  if (job.chatId != null && isMessagingChannel(job.channel)) {
    return { to: 'channel', channel: job.channel };
  }
  // Un chat désigné par le déclencheur, atteint sur SON canal : l'agent a la
  // credential de CE canal.
  const channel = designatedChatChannel(job);
  if (job.chatId == null || channel === undefined) return { to: 'result' };
  return opts.activeChannels.includes(channel) ? { to: 'channel', channel } : { to: 'result' };
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
    ...(reply.to === 'channel' ? { replyChannel: reply.channel } : {}),
    target: jobChatOn(chat, channel) !== null ? 'chat' : 'owner',
  };
}
