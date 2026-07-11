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

export type DiscordInteractionResult =
  | { handled: true; kind: 'approval'; decision: 'approve' | 'reject'; jobId: string }
  | { handled: true; kind: 'auth'; decision: 'allow' | 'deny'; conversationId: string }
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
