// chat/run-chat-turn.ts — generate one in-app chat reply WITHOUT creating a job.
//
// Conversation-first (V4): a chat turn is NOT a job. This produces a pure-text
// reply using the agent's personality + AUTO-INJECTED memory (recall is free —
// `buildSystemPrompt` splices the entity's durable facts into the prompt) +
// the recent history of THIS conversation. No tools are exposed, so nothing here
// can create a job. Action escalation (the agent uses a tool → a real
// `agent_jobs` row) is a later increment.

import { eq, and, desc } from '@nodal-agents/db';
import { agents, entityLlmKeys, chatMessages, conversations, agentJobs } from '@nodal-agents/db';
import { buildSystemPrompt } from '@nodal-agents/orchestration';
import type { Agent, AgentId, EntityId } from '@nodal-agents/orchestration';
import { createLlmClient } from '@nodal-agents/llm';
import { decrypt } from '@nodal-agents/secrets';
import { z } from 'zod';
import type { ModelMessage } from 'ai';
import type { RunnerDeps } from '../deps.ts';

const HISTORY_LIMIT = 20;
const DEFAULT_MODEL = 'claude-sonnet-4-6-20260217';
const TITLE_MAX = 60;

// The ONE tool the chat agent gets: escalate to a real job. Pure conversation +
// memory recall need no tool (recall is auto-injected). When the user asks for
// an ACTION, the agent calls run_task → we spawn an agent_jobs row that the
// agent then executes with its full toolset (delegating to sub-agents as
// needed). That spawned job — not the chat turn — is the unit that does work.
const CHAT_TOOLS = {
  run_task: {
    description:
      'Your gateway to EVERY capability you have. Calling this runs a tracked job with your ' +
      'full toolset — connectors, skills, delegation to your team, and (as the workspace ROOT) ' +
      'creating agents, skills, MCP servers, connectors or automations. Use it for ANY action: ' +
      'send, fetch, create, configure, publish, or multi-step work. Pass a clear, ' +
      'self-contained instruction. Never decline an action the user asks for — escalate it ' +
      'here. For plain conversation or recalling facts, reply in text instead (do not call this).',
    inputSchema: z.object({ instruction: z.string().min(1).max(4000) }),
  },
};

export type ChatTurnResult =
  | { ok: true; reply: string; spawnedJobId?: string }
  | { ok: false; error: string };

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
  const systemPrompt = await buildSystemPrompt(agent, db, {
    origin: 'dashboard',
    surface: 'chat',
  });

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

  // 5. One LLM call. The agent may reply in text (pure conversation) and/or call
  //    run_task to escalate an action into a real job. Guarded: some providers
  //    THROW when the model emits a tool call for a tool not in the set (a
  //    phantom built-in) — we swallow that and fall through to the tool-free
  //    retry in 6b so conversation still works.
  let text = '';
  let runTask: { input?: unknown } | undefined;
  try {
    const response = await llmClient.generateText({
      system: systemPrompt,
      messages,
      tools: CHAT_TOOLS,
    });
    text = (response.text ?? '').trim();
    runTask = (response.toolCalls ?? []).find((tc) => tc.toolName === 'run_task');
  } catch {
    // Fall through — the tool-free retry below produces a plain-text reply.
  }

  // 6a. ESCALATION: the agent wants to act → spawn a real job (the unit of work).
  //     The spawned job runs the ROOT with its full toolset (delegating to
  //     sub-agents → the dispatch cards). The chat just shows its progress.
  if (runTask) {
    const instruction =
      String((runTask.input as { instruction?: unknown } | undefined)?.instruction ?? '').trim() ||
      message;
    const [job] = await db
      .insert(agentJobs)
      .values({
        entityId,
        agentId,
        status: 'pending',
        channel: 'dashboard',
        task: instruction,
        messages: [{ role: 'user', content: instruction }],
      })
      .returning({ id: agentJobs.id });

    const reply = text || `On it — handling: ${instruction}`;
    await db.insert(chatMessages).values({
      entityId,
      agentId,
      conversationId,
      role: 'assistant',
      content: reply,
      jobId: job?.id ?? null,
    });
    await db
      .update(conversations)
      .set({ updatedAt: new Date() })
      .where(eq(conversations.id, conversationId));

    return { ok: true, reply, spawnedJobId: job?.id };
  }

  // 6b. Pure conversation — persist the assistant turn. No job created.
  //     If the model produced neither text nor a run_task call (e.g. it tried a
  //     tool that isn't available on this surface), force a plain-text answer
  //     with a tool-free retry so the user always gets a reply. The LLM still
  //     speaks — we never fabricate text (invariant #2).
  let replyText = text;
  if (!replyText) {
    try {
      const retry = await llmClient.generateText({ system: systemPrompt, messages });
      replyText = (retry.text ?? '').trim();
    } catch {
      return { ok: false, error: 'llm_error' };
    }
  }
  if (!replyText) return { ok: false, error: 'empty_reply' };
  await db
    .insert(chatMessages)
    .values({ entityId, agentId, conversationId, role: 'assistant', content: replyText });
  await db
    .update(conversations)
    .set({ updatedAt: new Date() })
    .where(eq(conversations.id, conversationId));

  return { ok: true, reply: replyText };
}
