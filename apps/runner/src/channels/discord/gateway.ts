// channels/discord/gateway.ts — one discord.js Client per channel_bindings
// row (channel='discord'), wired to the neutral inbound handler +
// interaction router. This is the ONLY file in this brique that talks to the
// real discord.js SDK (invariant #7: always use the official SDK) — every
// other file in channels/discord/ operates on the neutral shapes in types.ts
// so the state-machine logic stays testable without a live gateway.
//
// Intents:
//   - Guilds            — required baseline for guild-scoped caching/events.
//   - GuildMessages      — read messages posted in guild text channels.
//   - DirectMessages     — read DMs.
//   - MessageContent     — read message TEXT (a privileged intent — must be
//     enabled for the bot in the Discord Developer Portal, or every
//     message.content arrives empty).
// Partials: [Channel] — REQUIRED for DM messageCreate/interactionCreate
// events to fire at all: Discord does not send a full Channel payload for a
// DM unless the bot already has that channel cached, and discord.js drops
// events for uncached partial structures unless the partial is declared.
//
// messageCreate: bot authors (including ourselves) are ALWAYS ignored before
// anything else runs — the hard anti-ack-loop rule.
// interactionCreate: button taps only (isButton()) — routed by customId
// prefix to the approval or auth-confirmation flow (interactions.ts).

import {
  Client,
  Events,
  GatewayIntentBits,
  Partials,
  ChannelType,
  MessageFlags,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} from 'discord.js';
import type { Message, ButtonInteraction, Interaction, SendableChannels } from 'discord.js';
import { eq } from '@nodal-agents/db';
import { channelAllowedConversations } from '@nodal-agents/db';
import type { RunnerDeps } from '../../deps.ts';
import type { RunnerEnv } from '../../env.ts';
import {
  handleDiscordMessage,
  triggerJobWorker,
  attachInboundImage,
  type DiscordHandleResult,
} from './handler.ts';
import { routeDiscordInteraction } from './interactions.ts';
import { DISCORD_AUTH_CALLBACK_PREFIX } from './auth-callback.ts';
import type { DiscordInboundMessage } from './types.ts';

export interface DiscordGatewayOpts {
  agentId: string;
  agentEntityId: string;
  botToken: string;
  deps: RunnerDeps;
  env: RunnerEnv;
}

export interface DiscordGatewayHandle {
  stop(): Promise<void>;
}

/** Adapt a live discord.js Message into the neutral shape handler.ts operates on. */
function toInboundMessage(message: Message, botUserId: string | null): DiscordInboundMessage {
  const isDm = message.channel.type === ChannelType.DM;

  // Bot mention = the bot's USER (`<@id>`/`<@!id>`) OR its guild-managed ROLE
  // (`<@&roleId>`). Discord's autocomplete offers the role first when a human
  // types `@BotName`, so most real mentions arrive as role mentions — a
  // users-only check silently ignored them (live incident 2026-07-11).
  const userMentioned = botUserId !== null && message.mentions.users.has(botUserId);
  const managedRole =
    botUserId !== null
      ? message.mentions.roles.find((r) => r.tags?.botId === botUserId)
      : undefined;
  const selfMentionTokens = [
    ...(botUserId !== null ? [`<@${botUserId}>`, `<@!${botUserId}>`] : []),
    ...(managedRole ? [`<@&${managedRole.id}>`] : []),
  ];

  return {
    channelId: message.channelId,
    channelType: isDm ? 'dm' : 'guild_text',
    content: message.content ?? '',
    author: {
      id: message.author.id,
      bot: message.author.bot,
      username: message.author.username,
      globalName: message.author.globalName ?? null,
    },
    mentionedUserIds: [...message.mentions.users.keys()],
    mentionsSelf: userMentioned || managedRole !== undefined,
    selfMentionTokens,
    referencedMessageAuthorId: message.mentions.repliedUser?.id,
    attachments: [...message.attachments.values()].map((a) => ({
      url: a.url,
      contentType: a.contentType,
      size: a.size,
      name: a.name,
    })),
  };
}

/** True when a fetched Channel actually supports `.send()` — DM or guild text channel. */
function isSendable(channel: unknown): channel is SendableChannels {
  return (
    !!channel &&
    typeof channel === 'object' &&
    'isTextBased' in channel &&
    typeof (channel as { isTextBased: unknown }).isTextBased === 'function' &&
    (channel as { isTextBased: () => boolean }).isTextBased()
  );
}

export function startDiscordGateway(opts: DiscordGatewayOpts): DiscordGatewayHandle {
  const { agentId, agentEntityId, botToken, deps, env } = opts;

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.DirectMessages,
      GatewayIntentBits.MessageContent,
    ],
    partials: [Partials.Channel],
  });

  client.on(Events.ClientReady, (c) => {
    console.warn(`[discord-gateway agent=${agentId}] logged in as ${c.user.tag}`);
  });

  client.on(Events.Error, (err) => {
    console.error(`[discord-gateway agent=${agentId}] client error: ${err.message}`);
  });

  client.on(Events.MessageCreate, (message: Message) => {
    void onMessage(message).catch((err) => {
      console.error(
        `[discord-gateway agent=${agentId}] unhandled error in onMessage: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    });
  });

  client.on(Events.InteractionCreate, (interaction: Interaction) => {
    if (!interaction.isButton()) return;
    void onInteraction(interaction).catch((err) => {
      console.error(
        `[discord-gateway agent=${agentId}] unhandled error in onInteraction: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    });
  });

  async function onMessage(message: Message): Promise<void> {
    // Anti ack-loop hard rule — never react to ANY bot, including ourselves.
    // (handleDiscordMessage re-checks this too, for direct unit-test coverage.)
    if (message.author.bot) return;

    const inbound = toInboundMessage(message, client.user?.id ?? null);
    let result: DiscordHandleResult;
    try {
      result = await deps.db.transaction((tx) =>
        handleDiscordMessage({
          message: inbound,
          receivingAgentId: agentId,
          receivingAgentEntityId: agentEntityId,
          receivingAgentBotUserId: client.user?.id ?? null,
          tx: tx as unknown as RunnerDeps['db'],
        }),
      );
    } catch (err) {
      console.error(
        `[discord-gateway agent=${agentId}] message handling failed (channel=${message.channelId}): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return;
    }

    // Image attach: download it (network — out of the txn) and attach it to
    // the job BEFORE the worker runs, so the agent sees the image. Best-effort:
    // a failed download leaves the job text-only and the worker still runs.
    if (result.jobId && result.attachment) {
      await attachInboundImage({
        jobId: result.jobId,
        entityId: agentEntityId,
        attachment: result.attachment,
        db: deps.db,
      }).catch((err) => {
        console.warn(
          `[discord-gateway agent=${agentId}] image attach failed for job ${result.jobId}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      });
    }

    // Fire worker AFTER commit so we never wake a worker for a rolled-back job.
    if (result.jobId) {
      triggerJobWorker(result.jobId, env);
    }

    // H-1: an unknown conversation asked for access — ask the owner to
    // confirm (out of the txn: network I/O). Best-effort with a safety net:
    // if the owner card can't be sent, delete the pending row so a later
    // message re-asks rather than leaving the requester stuck in limbo.
    if (result.pendingAuth) {
      const pending = result.pendingAuth;
      await sendAuthConfirmation(pending).catch(async (err) => {
        console.warn(
          `[discord-gateway agent=${agentId}] auth-confirm send failed for conversation ` +
            `${pending.requesterConversationId}: ${err instanceof Error ? err.message : String(err)}; ` +
            'clearing pending row',
        );
        await deps.db
          .delete(channelAllowedConversations)
          .where(eq(channelAllowedConversations.id, pending.conversationRowId))
          .catch(() => {});
      });
    }
  }

  /**
   * Send the owner a button card to allow/deny a new conversation, and tell
   * the requester their request is pending. The owner card is load-bearing —
   * if it throws, the caller (above) clears the pending row. The requester
   * note is best-effort and never blocks.
   */
  async function sendAuthConfirmation(
    pending: NonNullable<DiscordHandleResult['pendingAuth']>,
  ): Promise<void> {
    const ownerChannel = await client.channels.fetch(pending.ownerConversationId);
    if (!isSendable(ownerChannel)) {
      throw new Error(`owner conversation ${pending.ownerConversationId} is not sendable`);
    }
    const target = pending.targetAgentName
      ? `souhaite parler à l'agent « ${pending.targetAgentName} » via ce bot`
      : 'souhaite parler à ce bot';
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`${DISCORD_AUTH_CALLBACK_PREFIX}:${pending.conversationRowId}:a`)
        .setLabel('✅ Autoriser')
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(`${DISCORD_AUTH_CALLBACK_PREFIX}:${pending.conversationRowId}:d`)
        .setLabel('❌ Refuser')
        .setStyle(ButtonStyle.Danger),
    );
    await ownerChannel.send({
      content: `👤 ${pending.requesterName} ${target}. Autoriser ?`,
      components: [row],
    });

    const requesterChannel = await client.channels
      .fetch(pending.requesterConversationId)
      .catch(() => null);
    if (isSendable(requesterChannel)) {
      await requesterChannel
        .send({
          content:
            'Votre demande a été transmise au propriétaire du bot pour autorisation. ' +
            'Vous pourrez écrire dès qu’elle est acceptée.',
        })
        .catch(() => {});
    }
  }

  async function onInteraction(interaction: ButtonInteraction): Promise<void> {
    const isDm = interaction.channel?.type === ChannelType.DM;
    const result = await routeDiscordInteraction({
      customId: interaction.customId,
      channelId: interaction.channelId,
      channelType: isDm ? 'dm' : 'guild_text',
      receivingAgentId: agentId,
      deps,
      env,
      ack: {
        async ephemeralReply(text: string): Promise<void> {
          await interaction.reply({ content: text, flags: MessageFlags.Ephemeral }).catch(() => {});
        },
        async resolveCard(text: string): Promise<void> {
          await interaction.update({ content: text, components: [] }).catch(() => {});
        },
      },
    });
    if (!result.handled && result.reason === 'unknown_custom_id') {
      // Not one of ours — ack so the client's spinner stops, never react to malformed/foreign taps otherwise.
      await interaction.deferUpdate().catch(() => {});
    }
  }

  void client.login(botToken).catch((err) => {
    console.warn(
      `[discord-gateway agent=${agentId}] login failed (invalid token?): ${
        err instanceof Error ? err.message : String(err)
      }; will retry on the manager's next refresh`,
    );
  });

  return {
    async stop(): Promise<void> {
      await client.destroy();
    },
  };
}
