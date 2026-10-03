// channels/discord/interactions.ts — route a Discord button tap by its
// customId prefix. Mirrors telegram/poller.ts's callback_query dispatch
// (`tgauth:` vs anything else = an approval tap).

import type { RunnerDeps } from '../../deps.ts';
import type { RunnerEnv } from '../../env.ts';
import type { DiscordInteractionAck } from './types.ts';
import {
  parseApprovalCallbackData,
  handleDiscordApprovalInteraction,
} from './approval-callback.ts';
import { parseDiscordAuthCallbackData, handleDiscordAuthInteraction } from './auth-callback.ts';
import { parseElicitationCallbackData } from '@nodal-agents/shared';
import { handleElicitationTap } from '../../approvals/elicitation-channel.ts';

export type DiscordInteractionResult =
  | { handled: true; kind: 'approval'; decision: 'approve' | 'reject' | 'answer'; jobId: string }
  | { handled: true; kind: 'auth'; decision: 'allow' | 'deny'; conversationId: string }
  /** 0145 — a gesture on the card of an MCP server's question. */
  | { handled: true; kind: 'elicitation' }
  | { handled: false; reason: string };

export async function routeDiscordInteraction(args: {
  customId: string;
  channelId: string;
  channelType: 'dm' | 'guild_text';
  receivingAgentId: string;
  ack: DiscordInteractionAck;
  deps: RunnerDeps;
  env: RunnerEnv;
}): Promise<DiscordInteractionResult> {
  const { customId, channelId, channelType, receivingAgentId, ack, deps, env } = args;

  const approvalParsed = parseApprovalCallbackData(customId);
  if (approvalParsed) {
    const result = await handleDiscordApprovalInteraction({
      parsed: approvalParsed,
      channelId,
      channelType,
      receivingAgentId,
      ack,
      deps,
      env,
    });
    return result.handled
      ? { handled: true, kind: 'approval', decision: result.decision, jobId: result.jobId }
      : result;
  }

  // `eli:` — a gesture on the card of an MCP server's question (0145). Acked
  // first (Discord wants an answer within 3 s), the card is redrawn by the
  // core, and its notice is shown to the tapper alone.
  if (parseElicitationCallbackData(customId)) {
    await ack.acknowledge();
    const result = await handleElicitationTap({
      deps,
      env,
      origin: { channel: 'discord', receivingAgentId, conversationId: channelId },
      data: customId,
    });
    if (result.notice) await ack.ephemeralReply(result.notice);
    return result.handled
      ? { handled: true, kind: 'elicitation' }
      : { handled: false, reason: result.reason };
  }

  const authParsed = parseDiscordAuthCallbackData(customId);
  if (authParsed) {
    const result = await handleDiscordAuthInteraction({
      parsed: authParsed,
      channelId,
      channelType,
      receivingAgentId,
      ack,
      deps,
    });
    return result.handled
      ? {
          handled: true,
          kind: 'auth',
          decision: result.decision,
          conversationId: result.conversationId,
        }
      : result;
  }

  return { handled: false, reason: 'unknown_custom_id' };
}
