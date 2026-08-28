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

import { App, SocketModeReceiver } from '@slack/bolt';
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
  /**
   * Called ONCE when this socket is finished — `start()` rejected, or the
   * websocket closed and will not come back on its own. The manager uses it to
   * drop the socket from its active set so the next refresh respawns it with
   * freshly-read credentials.
   *
   * Never called on a `stop()` we initiated: a deliberate shutdown is not a
   * death to recover from.
   *
   * The socket does NOT log the death itself: a permanently invalid token dies
   * on every retry, and a line per attempt from here plus one from the manager
   * was two log storms where the point was to have none. The manager owns the
   * message, with repeat-collapsing and backoff.
   */
  onClosed?: (reason: string) => void;
  /**
   * Called once the socket is really connected. Clears the manager's retry
   * backoff for this binding, so a binding that failed ten times and then
   * works is retried immediately the next time it drops — the earlier failures
   * are history, not a permanent penalty.
   */
  onConnected?: () => void;
}

export interface SlackSocketHandle {
  stop(): Promise<void>;
}

/**
 * Options for the Socket Mode receiver — exported so the reconnect posture is
 * assertable without standing up a real websocket.
 *
 * `autoReconnectEnabled: false` is the whole point. @slack/socket-mode 2.0.7
 * reconnects via `delayReconnectAttempt(this.start)`, whose body is
 * `cb.apply(this).then(res)` — with no `.catch`. When that retry hits an
 * UNRECOVERABLE error (`invalid_auth` after the token was revoked),
 * `retrieveWSSURL` rethrows into a promise nobody owns, and it surfaces as a
 * process-level `unhandledRejection`. Observed on a real install during the
 * 25/08 token rotation; only the runner's global handler kept the process up.
 *
 * Turning Bolt's reconnect off makes the failure land in the `start()` promise
 * WE await, and hands the retry to the manager — which already owns spawn /
 * despawn, rescans every 30s, and (unlike Bolt, which re-dials with the
 * credentials it captured at construction) re-reads the binding, so a rotated
 * token is actually picked up.
 */
export function slackReceiverOptions(appToken: string): {
  appToken: string;
  autoReconnectEnabled: boolean;
} {
  return { appToken, autoReconnectEnabled: false };
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

  // Own the receiver rather than letting App build one: it is the only way to
  // reach the SocketModeClient (a public field) and to set the reconnect
  // posture (see slackReceiverOptions). `socketMode` is NOT passed alongside —
  // supplying a receiver already selects the transport.
  const receiver = new SocketModeReceiver(slackReceiverOptions(appToken));
  // `deferInitialization` puts US in charge of App.init(), which verifies the
  // BOT token with an `auth.test` call. Left to Bolt, that verification runs on
  // its own and its rejection belongs to nobody: a revoked bot token surfaces
  // as a process-level `unhandledRejection` with the socket reporting itself
  // "connected". Found by running the real thing against a deliberately
  // invalidated token — eleven review passes and 1 137 tests had not caught it,
  // because every one of them used a fake.
  const app = new App({ token: botToken, receiver, deferInitialization: true });

  // `stop()` is a deliberate shutdown, not a death: it must not trigger the
  // manager's respawn path, and onClosed fires at most once either way.
  let shuttingDown = false;
  let closedReported = false;
  const reportClosed = (reason: string): void => {
    if (shuttingDown || closedReported) return;
    closedReported = true;
    opts.onClosed?.(reason);
  };

  // With Bolt's own reconnect disabled, a close is terminal for THIS socket.
  // Both events are wired: 'disconnected' is what SocketModeClient emits on a
  // close when autoReconnect is off, and 'error' covers a transport failure
  // that never reaches a clean close.
  receiver.client.on('disconnected', () => reportClosed('disconnected'));
  receiver.client.on('error', (err: unknown) => {
    reportClosed(`transport error: ${err instanceof Error ? err.message : String(err)}`);
  });

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

  // The whole startup chain, retained so stop() can await it. init() awaits an
  // `auth.test` round-trip, so there is a real window in which the manager may
  // despawn or rotate this binding: without the guards below, stop() would
  // disconnect the receiver and this continuation would then call start()
  // anyway — and the Slack SDK clears its own shutdown flag inside start(), so
  // the discarded app reconnects as an ORPHAN, with no handle the manager can
  // reach, happily processing messages on credentials the operator has just
  // removed (found by codex review, PR #42).
  const startup = app
    .init()
    .then(() => {
      if (shuttingDown) return;
      return app.start();
    })
    .then(async () => {
      if (shuttingDown) return;
      // Same observability discipline as discord/gateway.ts's ClientReady log
      // ("logged in as ...") — without it, confirming a socket actually
      // connected (and as which bot identity) requires a DB round-trip
      // instead of a grep. auth.test() is a single, cheap identity call made
      // once per successful connect, not per event.
      opts.onConnected?.();
      try {
        const identity = await app.client.auth.test();
        console.warn(
          `[slack-socket agent=${agentId}] connected (socket mode) as ${identity.user ?? 'unknown'} ` +
            `(team=${identity.team ?? 'unknown'})`,
        );
      } catch (err) {
        // Already reported connected above — auth.test is an identity nicety,
        // not the liveness signal.
        console.warn(
          `[slack-socket agent=${agentId}] connected (socket mode), but auth.test failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    })
    .catch((err) => {
      if (shuttingDown) return;
      // The old comment here promised "will retry on the manager's next
      // refresh". It did not: spawnOne registered this socket in the active
      // set whether or not start() succeeded, and the manager only respawns on
      // a credential CHANGE — so a socket that never connected stayed
      // registered forever and the agent was silently offline. Reporting the
      // failure is what makes that promise true. The MESSAGE is the manager's
      // to write (once, with backoff), not ours per attempt.
      reportClosed(`start failed: ${err instanceof Error ? err.message : String(err)}`);
    });

  void startup;

  return {
    async stop(): Promise<void> {
      shuttingDown = true;
      // Await the startup chain before tearing down: if init() is still in
      // flight, letting stop() return first is exactly how an orphan socket
      // gets created. The chain never rejects (it ends in a catch), so this
      // cannot throw here.
      await startup;
      await app.stop();
    },
  };
}
