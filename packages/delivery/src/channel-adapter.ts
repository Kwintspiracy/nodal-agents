// channel-adapter.ts — channel-neutral send surface (S1 of the multichannel plan).
//
// WHY this exists: every send-side caller today (approvals/notify.ts, the
// telegram_send_message tool, cron delivery, …) talks to `channels/telegram.ts`
// directly, so adding Discord/Slack/WhatsApp later would mean re-deriving the
// same wiring per channel. `ChannelAdapter` is the seam: ONE interface each
// channel implements, resolved via `getAdapter()` (registry.ts) instead of a
// hardcoded import. This file only defines the shape — the Telegram side keeps
// working exactly as before via `channels/telegram-adapter.ts`, which delegates
// to the existing, untouched `channels/telegram.ts` functions.
//
// The surface is intentionally minimal: only what today's callers need
// (send text, send media, send/resolve an approval card, edit a message,
// validate a bot's credentials). Extending it for a channel-specific feature
// happens when a real caller needs it, not speculatively.

/** Messaging platforms Nodal can deliver through. Extensible — add a kind here
 *  + a registry entry when its adapter ships; nothing else changes shape. */
export type ChannelKind = 'telegram' | 'discord' | 'slack' | 'whatsapp';

/**
 * Per-channel credential bag, jsonb-shaped (string values only — matches how
 * these are stored/read from the DB). Telegram's shape is `{ botToken }`.
 */
export type ChannelCredentials = Record<string, string>;

/** Plain-text formatting hint, channel-neutral. Each adapter maps this to its
 *  own wire format (Telegram: undefined/'MarkdownV2'/'HTML'). */
export type TextFormat = 'plain' | 'markdown' | 'html';

export interface SendTextOpts {
  format?: TextFormat;
  /**
   * Reprendre un envoi découpé au morceau `fromChunk` (compté depuis 0) : les
   * précédents sont déjà partis. C'est le `partialProgress.sentChunks` de la
   * `DeliveryError` que l'essai précédent a levée (#615). Le découpage d'un
   * même texte est déterministe, donc les morceaux sont les mêmes.
   */
  fromChunk?: number;
}

/** A file to deliver as chat media. `kind` picks the platform's native
 *  presentation (e.g. Telegram sendPhoto vs sendDocument vs sendVoice). */
export interface OutboundMedia {
  kind: 'photo' | 'document' | 'video' | 'audio' | 'voice';
  bytes: Uint8Array;
  filename: string;
  caption?: string;
}

/**
 * Neutral content for an approve/reject card. Each adapter renders its own
 * native buttons; `callbackId` is opaque to the adapter — it round-trips
 * through the platform's interaction payload (Telegram: encoded into each
 * button's `callback_data`) so the caller can recognize which card a tap
 * belongs to without the adapter knowing anything about approvals.
 */
export interface ApprovalCard {
  text: string;
  approveLabel: string;
  rejectLabel: string;
  /**
   * Optional third action: « toujours autoriser » (writes a standing
   * auto-approve rule after an in-channel confirmation step). Suffixed `:w`
   * on the callbackId. Adapters that don't render it (Discord/Slack today —
   * the confirm-by-message-edit flow is Telegram-only for now) simply keep
   * their two buttons; absent = the exact pre-existing card.
   */
  alwaysLabel?: string;
  callbackId: string;
}

/**
 * Une QUESTION posée à l'utilisateur, avec une option par bouton (P10a).
 *
 * Même contrat neutre que `ApprovalCard` : l'adapter ne sait rien des
 * questions, il sait rendre un texte et N boutons dont le `callback_data` est
 * `<callbackId>:o<index>`. Le suffixe `o<n>` est ce que le parseur
 * d'approbations (apps/runner) reconnaît — au plus six options, donc
 * `apr:` + un uuid + `:o5` fait 43 octets, bien sous le plafond de 64 de
 * Telegram.
 */
export interface QuestionCard {
  text: string;
  /** Les libellés, dans l'ordre. L'index du bouton EST l'index dans ce tableau. */
  options: string[];
  callbackId: string;
}

export interface SendResult {
  messageId: string;
}

/**
 * L'issue d'une réécriture de message (#637). Rendue, jamais avalée : un
 * appelant qui doit savoir si la carte a vraiment changé (la mise à jour des
 * cartes d'approbation, qui reprend un échec au tick suivant) le peut ; un
 * appelant que l'issue n'intéresse pas l'ignore. Jamais levée : une édition
 * ratée ne doit pas défaire la décision qu'elle raconte.
 */
export type EditResult = { ok: true } | { ok: false; error: string };

/**
 * Un bouton d'une carte réécrite (#637) — la forme neutre, par rangées. Seul
 * l'affichage interactif d'une carte encore ouverte en porte (la question
 * « Always allow? » de Telegram et son retour) ; une carte tranchée n'en a
 * aucun.
 */
export interface CardButton {
  label: string;
  callbackData: string;
}

/** Result of validating a channel's credentials (Telegram: getMe). */
export interface BotIdentity {
  id: string;
  username: string | null;
  displayName: string | null;
}

export interface ChannelCapabilities {
  /** Can render an interactive approve/reject card (sendApprovalCard is implemented). */
  buttons: boolean;
  /** Has a native concept of threads/topics within a conversation. */
  threads: boolean;
  /** Can deliver binary attachments (sendMedia is implemented). */
  media: boolean;
  /** Can rewrite a previously-sent message's text (editMessageText is implemented). */
  editMessage: boolean;
}

/** One conversation a bot/session can send into, as surfaced by a channel's
 *  own enumeration API (Discord: guild channels, Slack: users.conversations,
 *  WhatsApp: participating groups). Neutral shape — each adapter maps its own
 *  wire objects onto this, the same way OutboundMedia/ApprovalCard are the
 *  neutral shapes for sending. */
export type DiscoveredConversation = {
  conversationId: string;
  name: string;
  kind: 'private' | 'group' | 'channel' | 'thread';
  /** Grouping container when the platform has one (Discord guild name, Slack workspace) */
  groupName?: string;
};

/**
 * Ce que devient un texte envoyé par `sendText` SANS `format` — le seul fait
 * sur le canal dont un agent a besoin pour écrire sa réponse (#613).
 *
 * Le prompt d'un job sur canal portait 6 300 caractères de consignes écrites
 * à la main pour Telegram : échapper en MarkdownV2 alors que l'outil envoie
 * sans `parse_mode`, poser titres et tableaux sur un canal qui les affiche
 * tels quels, découper soi-même à 4 096 alors que `sendText` découpe déjà.
 * Trois consignes fausses, parce qu'écrites loin du code qui envoie. Ici,
 * l'adaptateur DÉCLARE ce qu'il fait, et les tests de chaque adaptateur
 * prouvent que la déclaration est ce que `sendText` fait.
 */
export interface TextDelivery {
  /**
   * Les marques que la plateforme REND dans un texte envoyé sans `format`,
   * écrites comme l'expéditeur les tape (`*bold*` pour Slack, `**bold**` pour
   * Discord). Tout le reste s'affiche tel quel. Vide : rien n'est rendu.
   *
   * Une liste, pas « plain » ou « markdown » : Slack et WhatsApp ne rendent
   * pas le markdown, mais leur propre balisage léger — les déclarer « plain »
   * faisait dire au prompt que `*gras*` s'afficherait avec ses astérisques,
   * alors qu'il s'affiche en gras (revue de #615). Le modèle écrit ce que le
   * canal rend, l'utilisateur lit un texte mis en forme.
   */
  renders: readonly string[];
  /**
   * Le plus long message que l'adaptateur envoie d'un bloc. Au-delà,
   * `sendText` découpe sur les fins de ligne et envoie les morceaux dans
   * l'ordre : l'appelant ne découpe jamais.
   */
  maxMessageChars: number;
}

export interface ChannelAdapter {
  readonly channel: ChannelKind;
  readonly capabilities: ChannelCapabilities;
  readonly text: TextDelivery;

  sendText(
    creds: ChannelCredentials,
    conversationId: string,
    text: string,
    opts?: SendTextOpts,
  ): Promise<SendResult>;

  sendMedia(
    creds: ChannelCredentials,
    conversationId: string,
    media: OutboundMedia,
  ): Promise<SendResult>;

  /** Optional: only channels with `capabilities.buttons` implement this. */
  sendApprovalCard?(
    creds: ChannelCredentials,
    conversationId: string,
    card: ApprovalCard,
  ): Promise<SendResult>;

  /**
   * Optional: only channels with `capabilities.buttons` implement this (P10a).
   * Separate from `sendApprovalCard` because the shape differs — N options
   * rather than a fixed approve/reject pair — and because a channel may render
   * one without the other.
   */
  sendQuestionCard?(
    creds: ChannelCredentials,
    conversationId: string,
    card: QuestionCard,
  ): Promise<SendResult>;

  /**
   * Optional: only channels with `capabilities.editMessage` implement this.
   * Rewrites the message's text and REPLACES its buttons with `buttons` — none
   * when absent or empty (a settled card). The only caller is the one function
   * that owns an approval card's display (runner approvals/card-settlement.ts,
   * #637). A channel that cannot put buttons on an edited message returns a
   * failure for a non-empty `buttons`, never a silent text-only edit.
   */
  editMessageText?(
    creds: ChannelCredentials,
    conversationId: string,
    messageId: string,
    text: string,
    buttons?: readonly (readonly CardButton[])[],
  ): Promise<EditResult>;

  /** Optional: only channels whose platform can enumerate what a bot/session
   *  could send into implement this (Telegram's Bot API has no such
   *  enumeration at all — see telegram-adapter.ts). */
  listConversations?(creds: ChannelCredentials): Promise<DiscoveredConversation[]>;

  validateCredentials(creds: ChannelCredentials): Promise<BotIdentity>;
}
