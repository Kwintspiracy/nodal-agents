// devices/device-scope.ts — what a device may reach besides its own routes: its own conversations (#946).
//
// A device key is scoped to ONE device and to that device's conversations:
// the `conversations` rows on the thread (`device`, its id) of its workspace,
// which `POST /api/devices/:deviceId/conversation` opens. The dashboard's
// routes a device speaks through (`/api/chat/stream`, `/api/voice/turns*`,
// `/api/chat/stop`, `/api/voice/replies/:audioId`) ask this function before
// acting on a conversation; `/api/approve` asks `deviceHoldsCard`.
//
// For any other caller (the dashboard, a session) the answer is yes: their
// own guard has already scoped them to their workspace, and a workspace's
// owner reaches all of its conversations.

import type { Context } from 'hono';
import { and, eq, approvalCardMessages, conversations } from '@nodal-agents/db';
import type { RunnerDeps } from '../deps.ts';

/** May the caller act on conversation `conversationId`? */
export async function callerReachesConversation(
  c: Context,
  db: RunnerDeps['db'],
  conversationId: string,
): Promise<boolean> {
  const device = c.get('callerDevice');
  if (!device) return true;
  const [row] = await db
    .select({ id: conversations.id })
    .from(conversations)
    .where(
      and(
        eq(conversations.id, conversationId),
        eq(conversations.entityId, device.entityId),
        eq(conversations.channel, 'device'),
        eq(conversations.chatId, device.id),
      ),
    )
    .limit(1);
  return row !== undefined;
}

/**
 * May the caller answer request `approvalRequestId`? A device answers only a
 * card that was put on IT (`approval_card_messages`, channel `device`, its
 * id): the questions and approvals of the requests made on it. Returns the
 * agent whose card it is, which `answeredBy` names, or null.
 */
export async function deviceHoldsCard(
  db: RunnerDeps['db'],
  deviceId: string,
  approvalRequestId: string,
): Promise<{ agentId: string } | null> {
  const [row] = await db
    .select({ agentId: approvalCardMessages.agentId })
    .from(approvalCardMessages)
    .where(
      and(
        eq(approvalCardMessages.approvalRequestId, approvalRequestId),
        eq(approvalCardMessages.channel, 'device'),
        eq(approvalCardMessages.conversationId, deviceId),
      ),
    )
    .limit(1);
  return row ?? null;
}
