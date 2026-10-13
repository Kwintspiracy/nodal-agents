// communication/telegram-send-message.ts — outbound Telegram message tool
//
// Registered per-agent when agents.telegramBotToken IS NOT NULL.
// The agent calls this tool to send a reply back to a Telegram chat.
// Credentials are fetched from the DB at execution time (never in closure).
//
// S3 (multichannel plan): sends through the channel-neutral ChannelAdapter
// (getAdapter) rather than calling the Telegram send helper directly.
// resolveChannelForJob picks the adapter — the job's own transport channel by
// default, or the optional `channel` argument below when the caller wants to
// target a DIFFERENT connected platform (cross-channel send).

import { z } from 'zod';
import { DeliveryError, getAdapter } from '@nodal-agents/delivery';
import { resolveBotToken, resolveRecipientChatId, resolveChannelForJob } from './delivery-guard';
import type { ToolDefinition, ToolContext } from '../types';
import { sentCard } from '../presenters';

// ─── Input / Output ───────────────────────────────────────────────────────────

const TelegramSendMessageInput = z.object({
  chatId: z
    .string()
    .regex(/^-?\d+$/, 'must be a numeric Telegram chat ID')
    .max(20)
    .optional()
    .describe('Telegram chat ID to send to. Omit to reply to the chat that triggered this job.'),
  // Pas de plafond (#613) : l'adaptateur découpe tout texte trop long pour le
  // canal (`ChannelAdapter.text.maxMessageChars`). Le `.max(4096)` d'avant
  // forçait le modèle à découper lui-même — et la limite de Discord est 2 000.
  text: z
    .string()
    .min(1)
    .describe('The whole reply. A text too long for one message is split automatically.'),
  channel: z
    .enum(['telegram', 'discord', 'slack', 'whatsapp'])
    .optional()
    .describe(
      'Target another connected platform; omit to reply on the current conversation’s channel.',
    ),
});

type TelegramSendMessageInput = z.infer<typeof TelegramSendMessageInput>;
/**
 * Ce que le MODÈLE reçoit après un envoi : un accusé de réception, rien de plus.
 *
 * Cet outil rendait `{messageId}`. Le 08/09/2026, un agent a lu le sien comme
 * un message de l'utilisateur — « User replied "2311"? … likely they mean port
 * 2311? » — et a tenu trois tours contre les identifiants de ses propres
 * envois, pour une seule question posée.
 *
 * L'identifiant ne servait à personne SUR CE CHEMIN : la file d'envoi
 * (`outbox.ts`) fait ses propres envois par l'adaptateur et construit son
 * receipt à partir de CEUX-LÀ — elle ne lit jamais la sortie de cet outil
 * (revue Codex, PR #48, qui a corrigé la première version de ce commentaire).
 * Ce que le modèle relit ne doit rien contenir qui ressemble à un message.
 */
type TelegramSendMessageOutput = { sent: true };

// ─── Envoi interrompu ─────────────────────────────────────────────────────────

/**
 * Les envois découpés qui ont échoué en route, par job, canal et destinataire :
 * le texte, et combien de ses morceaux sont déjà partis (revue de #615).
 *
 * Sans plafond de longueur, une réponse fait N messages. Un échec au 3e sur 4
 * laissait 1 et 2 livrés sans que rien ne le dise : la garde de livraison
 * redemandait l'envoi, le modèle renvoyait TOUT, et l'utilisateur recevait 1
 * et 2 deux fois. Le même texte renvoyé reprend maintenant au morceau manquant
 * (`SendTextOpts.fromChunk`) ; un autre texte est une autre réponse et part
 * entière. Borné, comme les compteurs de `delivery-guard.ts`.
 */
const partialSends = new Map<string, { text: string; sentChunks: number }>();
const MAX_PARTIAL_SENDS = 1000;

const partLabel = (from: number, to: number): string =>
  from === to ? `part ${from}` : `parts ${from}-${to}`;

/**
 * Retient ce qui est parti et le DIT dans l'erreur que le modèle lira : quels
 * morceaux ont atteint l'utilisateur, lesquels manquent, et que renvoyer le
 * même texte n'enverra que ceux-là. Rien de parti : l'erreur d'origine, telle
 * quelle.
 */
function partialSendError(err: unknown, key: string, text: string): unknown {
  const progress = err instanceof DeliveryError ? err.partialProgress : undefined;
  if (!progress || progress.sentChunks === 0) return err;
  partialSends.set(key, { text, sentChunks: progress.sentChunks });
  if (partialSends.size > MAX_PARTIAL_SENDS) {
    const oldest = partialSends.keys().next().value;
    if (oldest !== undefined) partialSends.delete(oldest);
  }
  const { sentChunks, totalChunks } = progress;
  const e = new Error(
    `send_partial: ${partLabel(1, sentChunks)} of ${totalChunks} reached the user, then the ` +
      `send failed (${(err as DeliveryError).message}). Sending the same text again sends only ` +
      `${partLabel(sentChunks + 1, totalChunks)}.`,
  );
  e.name = 'send_partial';
  return e;
}

// ─── Factory ──────────────────────────────────────────────────────────────────

/**
 * Create the telegram_send_message tool definition.
 *
 * Factory shape so the definition is stateless — all state (bot token,
 * chatId fallback) is resolved at execute-time from ctx.
 */
export function createTelegramSendMessageTool(): ToolDefinition<
  typeof TelegramSendMessageInput,
  TelegramSendMessageOutput
> {
  return {
    name: 'telegram_send_message',
    label: 'Send a Telegram message',
    summary:
      'Send a message through the connected Telegram bot. A sent message cannot be taken back.',
    description: `Send a text message on a messaging channel (Telegram, Discord or Slack).

- **chatId**: optional. Provide it only when sending to a chat other than the one
  this job answers. If you omit it, the platform uses the job's chat, or your
  owner's conversation when the job has none. An explicit chatId must already be an
  APPROVED chat for this agent (the owner, or a member the owner confirmed) —
  you cannot message an arbitrary chat id.
- **text**: the whole reply. Which marks render (none, markdown, the platform's own) is
  the channel's: see the \`delivery:\` line of your Job context. A text too long
  for one message is split automatically — send each reply in ONE call, never
  split it yourself.
- **channel**: optional. Target another connected platform (telegram, discord,
  slack, whatsapp) instead of the current conversation's — the agent must have
  an ENABLED binding for it. Omit to reply on the current conversation's channel.

**Stop when you're done**: send your message and call \`return_result\` in the same
response. Do NOT keep sending standalone acknowledgements, follow-ups, or
emoji-only messages turn after turn — the user did not ask for them and the
platform will cut you off for spamming if you send on several turns in a row
without finishing.

Fail conditions:
- If no chatId is provided, the job has no chat and no owner conversation is on
  record, the tool throws \`telegram_no_recipient\`. This is intentional — do not
  guess a chat ID.
- If the agent has no configured Telegram bot token, the tool throws
  \`telegram_no_bot_token\`. Fix: configure the bot token in agent settings.
- If an explicit chatId is not an approved chat for this agent, the tool throws
  \`telegram_chat_not_allowed\`.
- If \`channel\` names a platform this agent has no ENABLED binding for, the tool
  throws \`channel_not_connected\`.`,

    inputSchema: TelegramSendMessageInput,

    riskLevel: 'write',
    loading: 'eager',
    card: 'sent',
    present: ({ input }) =>
      sentCard({
        channel: input.channel ?? 'telegram',
        kind: 'message',
        ...(input.chatId ? { target: input.chatId } : {}),
      }),

    async execute(
      input: TelegramSendMessageInput,
      ctx: ToolContext,
    ): Promise<TelegramSendMessageOutput> {
      // 1. Resolve + authorize chatId — explicit arg wins (must be approved
      // unless it's the job's own origin chat), then job origin chat (F1).
      // `input.channel` targets another connected platform when given — see
      // resolveRecipientChatId's doc comment for the cross-channel rules.
      const chatId = await resolveRecipientChatId(
        input.chatId,
        ctx,
        'telegram_no_recipient',
        input.channel,
      );

      // 2. Bot token — the runner's resolved token wins (B3: a delegated worker
      // inheriting its entity's root agent's token); otherwise fall back to this
      // agent's own token from DB (credential isolation per agent, historical path).
      const botToken = await resolveBotToken(ctx, input.channel);
      if (!botToken) {
        const err = new Error('telegram_no_bot_token');
        err.name = 'telegram_no_bot_token';
        throw err;
      }

      // 3. Send via the channel-neutral adapter (battle-tested Telegram delivery
      // helper underneath — see channels/telegram-adapter.ts).
      const channel = await resolveChannelForJob(ctx, input.channel);
      const adapter = getAdapter(channel);
      const key = `${ctx.jobId ?? ''}\u0000${channel}\u0000${chatId}`;
      const pending = partialSends.get(key);
      const fromChunk = pending?.text === input.text ? pending.sentChunks : undefined;
      partialSends.delete(key);
      let res;
      try {
        res =
          fromChunk === undefined
            ? await adapter.sendText({ botToken }, chatId, input.text)
            : await adapter.sendText({ botToken }, chatId, input.text, { fromChunk });
      } catch (err) {
        throw partialSendError(err, key, input.text);
      }

      // `res.messageId` reste disponible ici pour qui en aurait besoin côté
      // runner ; il ne remonte simplement pas au modèle.
      void res;
      return { sent: true };
    },
  };
}
