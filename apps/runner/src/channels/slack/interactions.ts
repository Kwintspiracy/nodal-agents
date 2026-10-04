// channels/slack/interactions.ts — route a Slack block_actions button tap by
// its action_id prefix. Mirrors channels/discord/interactions.ts's dispatch
// (`apr:` vs `sauth:`).

import type { RunnerDeps } from '../../deps.ts';
import type { RunnerEnv } from '../../env.ts';
import type { SlackInteractionAck } from './types.ts';
import { parseApprovalCallbackData, handleSlackApprovalInteraction } from './approval-callback.ts';
import {
  parseSlackAuthCallbackData,
  handleSlackAuthInteraction,
  SLACK_AUTH_CALLBACK_PREFIX,
} from './auth-callback.ts';
import { ELICITATION_CALLBACK_PREFIX, parseElicitationCallbackData } from '@nodal-agents/shared';
import { handleElicitationTap } from '../../approvals/elicitation-channel.ts';
import { APPROVAL_CALLBACK_PREFIX } from '../../approvals/notify.ts';

/**
 * Every action_id this router dispatches, by prefix. The socket registers
 * exactly this pattern (`app.action`): one list, so a button the router knows
 * can never be one Slack does not deliver to it.
 */
export const SLACK_ACTION_ID_PATTERN = new RegExp(
  `^(${[APPROVAL_CALLBACK_PREFIX, ELICITATION_CALLBACK_PREFIX, SLACK_AUTH_CALLBACK_PREFIX].join('|')}):`,
);

export type SlackInteractionResult =
  | { handled: true; kind: 'approval'; decision: 'approve' | 'reject' | 'answer'; jobId: string }
  | { handled: true; kind: 'auth'; decision: 'allow' | 'deny'; conversationId: string }
  /** 0145 — a gesture on the card of an MCP server's question. */
  | { handled: true; kind: 'elicitation' }
  | { handled: false; reason: string };

export async function routeSlackInteraction(args: {
  actionId: string;
  channelId: string;
  channelType: 'im' | 'channel';
  receivingAgentId: string;
  ack: SlackInteractionAck;
  deps: RunnerDeps;
  env: RunnerEnv;
}): Promise<SlackInteractionResult> {
  const { actionId, channelId, channelType, receivingAgentId, ack, deps, env } = args;

  const approvalParsed = parseApprovalCallbackData(actionId);
  if (approvalParsed) {
    const result = await handleSlackApprovalInteraction({
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

  // `eli:` — a gesture on the card of an MCP server's question (0145). Slack
  // already got its ack (socket.ts); the card is redrawn by the core, and its
  // notice is shown to the tapper alone.
  if (parseElicitationCallbackData(actionId)) {
    const result = await handleElicitationTap({
      deps,
      env,
      origin: { channel: 'slack', receivingAgentId, conversationId: channelId },
      data: actionId,
    });
    if (result.notice) await ack.ephemeralReply(result.notice);
    return result.handled
      ? { handled: true, kind: 'elicitation' }
      : { handled: false, reason: result.reason };
  }

  const authParsed = parseSlackAuthCallbackData(actionId);
  if (authParsed) {
    const result = await handleSlackAuthInteraction({
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
