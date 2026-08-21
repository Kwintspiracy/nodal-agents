// channels/slack/socket.ts — one @slack/bolt App (Socket Mode) per
// channel_bindings row (channel='slack'), wired to the neutral inbound
// handler + interaction router. This is the ONLY file in this brique that
// talks to the real @slack/bolt SDK (invariant #7: always use the official
// SDK) — every other file in channels/slack/ operates on the neutral shapes
// in types.ts, mirroring channels/discord/gateway.ts's role exactly (see its
// file header for the same rationale).
//
// Event wiring:
//   - `message` (app.message) — DMs (`channel_type: 'im'`) are handled here
//     directly; anything else (a public/private channel, MPIM) is dropped —
//     channel-kind messages are ONLY ever acted on via `app_mention` below,
//     so the SAME message is never processed twice. Any subtype (edits,
//     joins, `bot_message`, …) is dropped outright — only a plain, freshly
//     authored human message (`subtype: undefined`) is ever handled.
//   - `app_mention` (app.event) — the bot was @mentioned in a channel it's a
//     member of. This IS Slack's own mention gate (see types.ts's file
//     header) — there is no separate "was this a mention" check to run.
//   - `block_actions` (app.action) — button taps, routed by action_id prefix
//     (`apr:` / `sauth:`) to the approval or auth-confirmation flow
//     (interactions.ts). Bolt requires `ack()` within 3s of receipt; it is
//     called FIRST, before any DB work, same discipline HTTPReceiver-based
//     Bolt apps need — Socket Mode has no hard HTTP timeout but the 3s budget
//     is still enforced platform-side.
//
// Anti ack-loop: a `bot_message` subtype or any event carrying `bot_id` is
// dropped before anything else runs — the hard rule, mirrored from
// discord/gateway.ts's `message.author.bot` check.

import { App } from '@slack/bolt';
import type { WebClient } from '@slack/web-api';
import { eq } from '@nodal-agents/db';
import { channelAllowedConversations } from '@nodal-agents/db';
import type { RunnerDeps } from '../../deps.ts';
import type { RunnerEnv } from '../../env.ts';
import { handleSlackMessage, triggerJobWorker, type SlackHandleResult } from './handler.ts';
import { routeSlackInteraction } from './interactions.ts';
import { SLACK_AUTH_CALLBACK_PREFIX } from './auth-callback.ts';
import type { SlackInboundMessage, SlackInteractionAck } from './types.ts';

export interface SlackSocketOpts {
  agentId: string;
  agentEntityId: string;
  botToken: string;
  appToken: string;
  deps: RunnerDeps;
  env: RunnerEnv;
}

export interface SlackSocketHandle {
  stop(): Promise<void>;
}

/**
 * Minimal shape this module actually reads off a `message` event. Bolt types
 * `message` as a ~20-member discriminated union of every subtype (joins,
 * edits, bot_message, …) — rather than fight that union for the handful of
 * fields every variant shares, adapt defensively: `subtype`/`bot_id` are
 * checked BEFORE anything else is trusted, so a variant this shape doesn't
 * actually match is already filtered out by the time its other fields matter.
 */
interface SlackMessageEventLike {
  subtype?: string;
  channel: string;
  channel_type?: string;
  user?: string;
  bot_id?: string;
  text?: string;
}

/** Minimal shape this module reads off a `block_actions` payload. */
interface SlackBlockActionBody {
  actions: Array<{ action_id?: string }>;
  user: { id: string };
  channel?: { id: string };
  message?: { ts?: string };
}

/** Slack conversation ids are prefixed by kind: `D`=DM, `C`=public channel,
 *  `G`=private channel/MPIM. Used to classify a block_actions tap without an
 *  extra `conversations.info` round-trip — a well-established, stable Slack
 *  convention (the SAME one `channel_type` on message events encodes). */
function isDmChannelId(channelId: string): boolean {
  return channelId.startsWith('D');
}

/**
 * Resolve a user id to a display name for sanitizeSenderName — unlike
 * Discord (whose message payload already embeds the author's username),
 * Slack's events only carry a user ID, so this is a real API call. Best
 * effort: a failed lookup must never drop an otherwise-valid inbound message,
 * so it falls back to the raw id.
 */
async function resolveSenderName(client: WebClient, userId: string): Promise<string> {
  try {
    const res = await client.users.info({ user: userId });
    return res.user?.profile?.display_name || res.user?.real_name || res.user?.name || userId;
  } catch {
    return userId;
  }
}

export function startSlackSocket(opts: SlackSocketOpts): SlackSocketHandle {
  const { agentId, agentEntityId, botToken, appToken, deps, env } = opts;

  const app = new App({ token: botToken, appToken, socketMode: true });

  app.error(async (err) => {
    console.error(`[slack-socket agent=${agentId}] app error: ${err.message}`);
  });

  app.message(async ({ message, client, context }) => {
    const msg = message as unknown as SlackMessageEventLike;
    // Anti ack-loop hard rule — never react to ANY bot, including ourselves.
    // Also drops every non-plain subtype (edits, joins, bot_message, …).
    if (msg.subtype !== undefined || msg.bot_id) return;
    // Channel-kind messages are handled ONLY via app_mention below — acting
    // on both would create two jobs for the same human message.
    if (msg.channel_type !== 'im') return;
    if (!msg.user) return;

    await onMessage(
      {
        conversationId: msg.channel,
        channelType: 'im',
        text: msg.text ?? '',
        user: { id: msg.user, bot: false, displayName: await resolveSenderName(client, msg.user) },
      },
      client,
      context.botUserId ?? null,
    ).catch((err) => {
      console.error(
        `[slack-socket agent=${agentId}] unhandled error in onMessage (im): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    });
  });

  app.event('app_mention', async ({ event, client, context }) => {
    if (event.bot_id || !event.user) return;

    await onMessage(
      {
        conversationId: event.channel,
        channelType: 'channel',
        text: event.text ?? '',
        user: {
          id: event.user,
          bot: false,
          displayName: await resolveSenderName(client, event.user),
        },
      },
      client,
      context.botUserId ?? null,
    ).catch((err) => {
      console.error(
        `[slack-socket agent=${agentId}] unhandled error in onMessage (app_mention): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    });
  });

  async function onMessage(
    inbound: SlackInboundMessage,
    client: WebClient,
    botUserId: string | null,
  ): Promise<void> {
    let result: SlackHandleResult;
    try {
      result = await deps.db.transaction((tx) =>
        handleSlackMessage({
          message: inbound,
          receivingAgentId: agentId,
          receivingAgentEntityId: agentEntityId,
          receivingAgentBotUserId: botUserId,
          tx: tx as unknown as RunnerDeps['db'],
        }),
      );
    } catch (err) {
      console.error(
        `[slack-socket agent=${agentId}] message handling failed (conversation=${inbound.conversationId}): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return;
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
      await sendAuthConfirmation(client, pending).catch(async (err) => {
        console.warn(
          `[slack-socket agent=${agentId}] auth-confirm send failed for conversation ` +
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
    client: WebClient,
    pending: NonNullable<SlackHandleResult['pendingAuth']>,
  ): Promise<void> {
    // CHANNEL-001: no owner yet — this request IS the owner claim, held pending
    // until a human approves it in the dashboard. Nobody to card; tell the
    // claimant where the decision happens.
    if (pending.ownerConversationId === null) {
      await client.chat
        .postMessage({
          channel: pending.requesterConversationId,
          text:
            'Demande enregistrée. Ce bot n’a pas encore de propriétaire : ouvrez son tableau ' +
            'de bord, onglet Channels de l’agent, et autorisez cette conversation pour en ' +
            'prendre le contrôle.',
        })
        .catch(() => {});
      return;
    }

    const target = pending.targetAgentName
      ? `souhaite parler à l'agent « ${pending.targetAgentName} » via ce bot`
      : 'souhaite parler à ce bot';
    await client.chat.postMessage({
      channel: pending.ownerConversationId,
      text: `👤 ${pending.requesterName} ${target}. Autoriser ?`,
      blocks: [
        {
          type: 'section',
          text: { type: 'mrkdwn', text: `👤 *${pending.requesterName}* ${target}. Autoriser ?` },
        },
        {
          type: 'actions',
          elements: [
            {
              type: 'button',
              text: { type: 'plain_text', text: '✅ Autoriser' },
              style: 'primary',
              action_id: `${SLACK_AUTH_CALLBACK_PREFIX}:${pending.conversationRowId}:a`,
            },
            {
              type: 'button',
              text: { type: 'plain_text', text: '❌ Refuser' },
              style: 'danger',
              action_id: `${SLACK_AUTH_CALLBACK_PREFIX}:${pending.conversationRowId}:d`,
            },
          ],
        },
      ],
    });

    await client.chat
      .postMessage({
        channel: pending.requesterConversationId,
        text:
          'Votre demande a été transmise au propriétaire du bot pour autorisation. ' +
          'Vous pourrez écrire dès qu’elle est acceptée.',
      })
      .catch(() => {});
  }

  app.action(/^(apr|sauth):/, async ({ ack, body, client }) => {
    await ack();
    const b = body as unknown as SlackBlockActionBody;
    const actionId = b.actions[0]?.action_id;
    const channelId = b.channel?.id;
    const messageTs = b.message?.ts;
    if (!actionId || !channelId) return;

    const slackAck: SlackInteractionAck = {
      async ephemeralReply(text: string): Promise<void> {
        await client.chat
          .postEphemeral({ channel: channelId, user: b.user.id, text })
          .catch(() => {});
      },
      async resolveCard(text: string): Promise<void> {
        if (!messageTs) return;
        await client.chat
          .update({ channel: channelId, ts: messageTs, text, blocks: [] })
          .catch(() => {});
      },
    };

    await routeSlackInteraction({
      actionId,
      channelId,
      channelType: isDmChannelId(channelId) ? 'im' : 'channel',
      receivingAgentId: agentId,
      ack: slackAck,
      deps,
      env,
    }).catch((err) => {
      console.error(
        `[slack-socket agent=${agentId}] unhandled error in routeSlackInteraction: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    });
  });

  void app
    .start()
    .then(async () => {
      // Same observability discipline as discord/gateway.ts's ClientReady log
      // ("logged in as ...") — without it, confirming a socket actually
      // connected (and as which bot identity) requires a DB round-trip
      // instead of a grep. auth.test() is a single, cheap identity call made
      // once per successful connect, not per event.
      try {
        const identity = await app.client.auth.test();
        console.warn(
          `[slack-socket agent=${agentId}] connected (socket mode) as ${identity.user ?? 'unknown'} ` +
            `(team=${identity.team ?? 'unknown'})`,
        );
      } catch (err) {
        console.warn(
          `[slack-socket agent=${agentId}] connected (socket mode), but auth.test failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    })
    .catch((err) => {
      console.warn(
        `[slack-socket agent=${agentId}] start failed (invalid token(s)?): ${
          err instanceof Error ? err.message : String(err)
        }; will retry on the manager's next refresh`,
      );
    });

  return {
    async stop(): Promise<void> {
      await app.stop();
    },
  };
}
