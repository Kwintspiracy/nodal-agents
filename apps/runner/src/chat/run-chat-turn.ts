// chat/run-chat-turn.ts — generate one in-app chat reply WITHOUT creating a job.
//
// Conversation-first (V4): a chat turn is NOT a job. This produces a pure-text
// reply using the agent's personality + AUTO-INJECTED memory (recall is free —
// `buildSystemPrompt` splices the entity's durable facts into the prompt) +
// the recent history of THIS conversation. No tools are exposed, so nothing here
// can create a job. Action escalation (the agent uses a tool → a real
// `agent_jobs` row) is a later increment.

import { eq, and, desc } from '@nodal-agents/db';
import { agents, entityLlmKeys, chatMessages, conversations } from '@nodal-agents/db';
import { buildSystemPrompt } from '@nodal-agents/orchestration';
import type { Agent, AgentId, EntityId } from '@nodal-agents/orchestration';
import { createLlmClient } from '@nodal-agents/llm';
import { decrypt } from '@nodal-agents/secrets';
import type { ModelMessage } from 'ai';
import type { RunnerDeps } from '../deps.ts';

const HISTORY_LIMIT = 20;
const DEFAULT_MODEL = 'claude-sonnet-4-6-20260217';
const TITLE_MAX = 60;

export type ChatTurnResult = { ok: true; reply: string } | { ok: false; error: string };

export async function runChatTurn(opts: {
  deps: RunnerDeps;
  entityId: string;
  agentId: string;
  conversationId: string;
  message: string;
}): Promise<ChatTurnResult> {
  const { deps, entityId, agentId, conversationId, message } = opts;
  const db = deps.db;

  // 1. Load + verify the agent belongs to this entity.
  const [agentRow] = await db
    .select()
    .from(agents)
    .where(and(eq(agents.id, agentId), eq(agents.entityId, entityId)))
    .limit(1);
  if (!agentRow || !agentRow.active) return { ok: false, error: 'agent_not_found' };
  if (!agentRow.llmKeyId) return { ok: false, error: 'agent_no_llm_configured' };

  // 1a. Verify the conversation belongs to this entity (the sidebar entry).
  const [conv] = await db
    .select({ id: conversations.id, title: conversations.title })
    .from(conversations)
    .where(and(eq(conversations.id, conversationId), eq(conversations.entityId, entityId)))
    .limit(1);
  if (!conv) return { ok: false, error: 'conversation_not_found' };

  // 1b. Persist the user turn IMMEDIATELY — before the (slower) LLM resolution +
  // system-prompt build — so it's visible the instant the user navigates back to
  // /chat, even while the reply is still generating. (Single writer = runner.)
  await db
    .insert(chatMessages)
    .values({ entityId, agentId, conversationId, role: 'user', content: message });
  // First message names the conversation (cheap auto-title; LLM summary later).
  if (!conv.title) {
    const title =
      message.trim().slice(0, TITLE_MAX) + (message.trim().length > TITLE_MAX ? '…' : '');
    await db.update(conversations).set({ title }).where(eq(conversations.id, conversationId));
  }

  // 2. Resolve the per-agent LLM client (same resolution as executeJob).
  const [keyRow] = await db
    .select()
    .from(entityLlmKeys)
    .where(eq(entityLlmKeys.id, agentRow.llmKeyId))
    .limit(1);
  if (!keyRow || !keyRow.isActive) return { ok: false, error: 'agent_no_llm_configured' };

  let llmClient: ReturnType<typeof createLlmClient>;
  try {
    const plaintextKey = keyRow.apiKey ? decrypt(keyRow.apiKey) : '';
    llmClient = createLlmClient({
      provider: keyRow.provider as Parameters<typeof createLlmClient>[0]['provider'],
      model: agentRow.model ?? DEFAULT_MODEL,
      apiKey: plaintextKey || undefined,
      baseURL: keyRow.baseUrl ?? undefined,
    });
  } catch {
    return { ok: false, error: 'llm_key_invalid' };
  }

  // 3. System prompt — memory is AUTO-INJECTED here (recall is free). The
  //    origin:'dashboard' job-context steers the agent to reply in plain text.
  const agent: Agent = {
    id: agentRow.id as AgentId,
    name: agentRow.name,
    slug: agentRow.slug,
    role: (agentRow.role ?? 'agent') as Agent['role'],
    personality: agentRow.personality,
    entityId: (agentRow.entityId ?? null) as EntityId | null,
    model: agentRow.model ?? DEFAULT_MODEL,
    active: agentRow.active ?? true,
    orchestratorMode: (agentRow.orchestratorMode ?? null) as 'router' | 'planner' | null,
    memoryTokenBudget: agentRow.memoryTokenBudget,
  };
  const systemPrompt = await buildSystemPrompt(agent, db, { origin: 'dashboard' });

  // 4. Load recent history of THIS conversation (most recent N, chronological).
  const rows = await db
    .select({ role: chatMessages.role, content: chatMessages.content })
    .from(chatMessages)
    .where(eq(chatMessages.conversationId, conversationId))
    .orderBy(desc(chatMessages.createdAt))
    .limit(HISTORY_LIMIT);
  const messages: ModelMessage[] = rows
    .reverse()
    .map((r) => ({ role: r.role as 'user' | 'assistant', content: r.content }));

  // 5. One LLM call, NO tools — pure conversation (cannot create a job).
  const response = await llmClient.generateText({ system: systemPrompt, messages, tools: {} });
  const reply = (response.text ?? '').trim();
  if (!reply) return { ok: false, error: 'empty_reply' };

  // 6. Persist the assistant turn + bump conversation recency. No job created.
  await db
    .insert(chatMessages)
    .values({ entityId, agentId, conversationId, role: 'assistant', content: reply });
  await db
    .update(conversations)
    .set({ updatedAt: new Date() })
    .where(eq(conversations.id, conversationId));

  return { ok: true, reply };
}
