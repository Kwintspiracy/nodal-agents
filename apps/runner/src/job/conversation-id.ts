// conversation-id.ts — assign a NEW conversational job (an inbound user
// message, not a delegation/cron/task-board child) to a conversation_id, for
// the Jobs page grouping (migration 0059). Purely a reporting concern: it
// never influences the runtime execution path.
//
// Reuses the EXACT session boundary loadThreadHistory (thread-history.ts)
// already uses for chat continuity, so "same conversation" means the same
// thing everywhere in the app: the most recent prior job in the same
// (entity, agent, channel, chat_id) tuple is the same conversation when the
// SILENCE since it was delivered (completed_at, falling back to created_at
// for a still-open job) is under IDLE_RESET_MS — otherwise this is a fresh
// conversation and gets a new id. See thread-history.ts's header for the
// full rationale (why completed_at, not created_at→created_at).

import { randomUUID } from 'node:crypto';
import { eq, and, desc } from '@nodal-agents/db';
import { agentJobs } from '@nodal-agents/db';
import type { RunnerDeps } from '../deps.ts';
import { IDLE_RESET_MS } from './thread-history.ts';

export interface ResolveConversationIdOptions {
  db: RunnerDeps['db'];
  entityId: string;
  agentId: string;
  /** Job's `channel` column — `telegram`, `slack`, etc. */
  channel: string;
  /** Job's `chat_id` column — the thread identifier on the channel. */
  chatId: string;
}

/**
 * Resolve the conversation_id for a new conversational job: inherit the most
 * recent prior job's conversation_id in the same thread when it's still
 * within the idle-reset window, otherwise mint a fresh uuid.
 *
 * Always returns a usable id (never null) — a brand-new thread, or a prior
 * job that predates the conversation_id column (not yet backfilled), both
 * just start a new conversation from here on.
 */
export async function resolveConversationId(opts: ResolveConversationIdOptions): Promise<string> {
  const [prior] = await opts.db
    .select({
      conversationId: agentJobs.conversationId,
      createdAt: agentJobs.createdAt,
      completedAt: agentJobs.completedAt,
    })
    .from(agentJobs)
    .where(
      and(
        eq(agentJobs.entityId, opts.entityId),
        eq(agentJobs.agentId, opts.agentId),
        eq(agentJobs.channel, opts.channel),
        eq(agentJobs.chatId, opts.chatId),
      ),
    )
    .orderBy(desc(agentJobs.createdAt))
    .limit(1);

  if (prior?.conversationId) {
    const deliveredAt = prior.completedAt
      ? new Date(prior.completedAt as unknown as string | number | Date).getTime()
      : new Date(prior.createdAt as unknown as string | number | Date).getTime();
    if (Date.now() - deliveredAt < IDLE_RESET_MS) {
      return prior.conversationId;
    }
  }

  return randomUUID();
}
