// devices/device-conversation.ts — a device's conversation with its workspace's root agent (#945, #946).
//
// ONE path, taken by the device route (`POST /api/devices/:deviceId/conversation`)
// and by the confirmation of a pairing: the thread (`device`, its id) with the
// workspace's ROOT agent — the agent the dashboard's chat talks to — resolved
// like a Telegram chat's (`resolveConversation`). `fresh` opens a new one, as
// `/new` does on a channel.

import { and, eq, entities, agents } from '@nodal-agents/db';
import type { RunnerDeps } from '../deps.ts';
import { openNewConversation, resolveConversation } from '../job/conversation-id.ts';

export type DeviceConversationOutcome =
  | { ok: true; agentId: string; conversationId: string }
  | { ok: false; code: 'no_root_agent' };

/**
 * The current (or, `fresh`, a new) conversation of device `deviceId` of
 * workspace `entityId`. Call it inside a transaction: the thread's advisory
 * lock holds until COMMIT, so two first requests never open two conversations
 * (job/conversation-id.ts).
 */
export async function deviceConversation(
  tx: RunnerDeps['db'],
  params: { entityId: string; deviceId: string; fresh?: boolean },
): Promise<DeviceConversationOutcome> {
  // The workspace's ROOT agent, as the dashboard's chat resolves it — and an
  // active agent of THIS workspace: a root that left it answers nobody.
  const [root] = await tx
    .select({ agentId: agents.id })
    .from(entities)
    .innerJoin(agents, and(eq(agents.id, entities.rootAgentId), eq(agents.entityId, entities.id)))
    .where(and(eq(entities.id, params.entityId), eq(agents.active, true)))
    .limit(1);
  if (!root) return { ok: false, code: 'no_root_agent' };
  const key = {
    db: tx,
    entityId: params.entityId,
    agentId: root.agentId,
    channel: 'device',
    chatId: params.deviceId,
  };
  const conversation = params.fresh
    ? await openNewConversation(key)
    : await resolveConversation(key);
  return { ok: true, agentId: root.agentId, conversationId: conversation.id };
}
