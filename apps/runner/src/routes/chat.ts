// routes/chat.ts — POST /api/chat — generate one in-app chat reply.
//
// Conversation-first: this NEVER creates an agent_jobs row (pure conversation).
// The web calls it (WORKER_SECRET bearer) with the resolved entity + agent.
//
// POST /api/chat { entityId, agentId, message, threadId? } → { reply }

import type { Context } from 'hono';
import { z } from 'zod';
import type { RunnerDeps } from '../deps.ts';
import type { RunnerEnv } from '../env.ts';
import { runChatTurn } from '../chat/run-chat-turn.ts';
import { executeJob } from '../job/execute.ts';
import type { JobId } from '@nodal-agents/orchestration';

const ChatRequestSchema = z.object({
  entityId: z.string().guid(),
  agentId: z.string().guid(),
  conversationId: z.string().guid(),
  // Generous cap (matches the web SendChatMessageSchema): large pasted skills/personalities.
  message: z.string().min(1).max(200_000),
});

export async function chatRoute(
  c: Context,
  deps: RunnerDeps,
  runnerEnv: RunnerEnv,
): Promise<Response> {
  const body = await c.req.json().catch(() => null);
  const parsed = ChatRequestSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'invalid_request', issues: parsed.error.issues }, 400);
  }
  const { entityId, agentId, conversationId, message } = parsed.data;

  const result = await runChatTurn({ deps, entityId, agentId, conversationId, message });
  if (!result.ok) {
    const notFound =
      result.error === 'agent_not_found' || result.error === 'conversation_not_found';
    return c.json({ error: result.error }, notFound ? 404 : 400);
  }

  // If the turn escalated to an action, run that job in the background (the chat
  // returns the agent's acknowledgement immediately; the UI polls the job for
  // its dispatch/progress).
  if (result.spawnedJobId) {
    const jobId = result.spawnedJobId as JobId;
    void executeJob(jobId, deps, runnerEnv).catch((err: unknown) => {
      console.error('[chatRoute] spawned job failed:', err);
    });
  }

  return c.json({ reply: result.reply });
}
