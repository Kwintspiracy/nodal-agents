// chat/run-chat-turn.ts — generate one in-app chat reply WITHOUT creating a job.
//
// Conversation-first (V4): a chat turn is NOT a job. This produces a pure-text
// reply using the agent's personality + AUTO-INJECTED memory (recall is free —
// `buildSystemPrompt` splices the entity's durable facts into the prompt) +
// the recent history of THIS conversation. No tools are exposed, so nothing here
// can create a job. Action escalation (the agent uses a tool → a real
// `agent_jobs` row) is a later increment.

import { eq, and, desc } from '@nodal-agents/db';
import { agents, chatMessages, conversations, agentJobs } from '@nodal-agents/db';
import { buildSystemPrompt } from '@nodal-agents/orchestration';
import type { Agent, AgentId, EntityId } from '@nodal-agents/orchestration';
import { resolveAgentLlmClient } from '../job/resolve-llm.ts';
import { getDeploymentContext } from '../job/deployment.ts';
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
      'send, fetch, create, configure, publish, or multi-step work.\n' +
      'CONVEY THE REQUEST FAITHFULLY. The WHAT is the user’s, not yours: pass their actual ' +
      'words and data through (verbatim where it matters — a pasted file, an exact phrasing). ' +
      'Do NOT invent scope, sub-topics, sources, an analysis plan, a method, or a delivery the ' +
      'user did not state — that is the worker’s own skills and judgment, and pre-deciding it ' +
      'risks drifting from what the user asked. Add only what the user explicitly said (e.g. a ' +
      'destination they named). If the conversation spans turns, make the instruction ' +
      'self-contained by carrying the user’s intent across turns — NOT by enriching it.\n' +
      'Never decline an action the user asks for — escalate it here. For plain conversation or ' +
      'recalling facts, reply in text instead (do not call this).',
    inputSchema: z.object({ instruction: z.string().min(1).max(16000) }),
  },
};

// Escalation-recovery nudge. A reasoning model (MiniMax M3) intermittently
// NARRATES an action in text ("Je lance X…") without emitting the run_task tool
// call — ~1 turn in 5 in practice. We cannot force tool_choice (MiniMax's
// OpenRouter endpoints 404 on any forced value). So when the model produced text
// but no run_task, we re-prompt ONCE with this reminder. Pure conversation is
// unaffected: no action was committed, so the model calls nothing and we keep
// the text reply. This is LLM-internal steering (never shown to the user).
const ESCALATION_RECHECK =
  'Re-read your previous reply. If it committed to performing an action — running, launching, ' +
  'sending, fetching, creating, configuring, delegating, or any task or tool use — then your ' +
  'text ALONE did nothing: call the run_task tool NOW, conveying the user’s request faithfully ' +
  '(their words and data, with no invented scope, method, or delivery). ' +
  'If your reply was pure conversation, a question, or simply recalling a fact, do not call any ' +
  'tool — the conversation is complete.';

export type ChatTurnResult =
  | { ok: true; reply: string; spawnedJobId?: string }
  | { ok: false; error: string };

/**
 * Build the run_task tool-result for a PRIOR chat escalation, reflecting the
 * job's REAL outcome at read time. This replaces a static "Task dispatched."
 * that left the orchestrator permanently blind to completion: it could never
 * tell a finished delegation from a still-running one, so it re-launched tasks
 * and looped on sequential work (live: the Conciergus Cortex sequence). Now it
 * sees the signal (done / running / failed) AND the content. Pure: the job's
 * `result` is the single source of truth — `completeJob`/`failJob` already fill
 * it from the delegated children when the parent didn't re-publish, so there is
 * nothing to recompile here.
 */
function buildDispatchOutput(
  status: string | null,
  result: string | null,
  error: string | null,
): string {
  const r = (result ?? '').trim();
  if (status === 'completed') {
    return `Completed.\n${r || '(no textual output was recorded)'}`;
  }
  if (status === 'failed') {
    return `FAILED — report this to the user with the reason; do not silently retry.\n${r || error || 'unknown error'}`;
  }
  if (status === 'cancelled') return 'Cancelled by the user.';
  // pending / processing / awaiting_approval / awaiting_delegation
  return 'Still running — no result yet. Do NOT dispatch it again; wait for it to finish.';
}

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

  // 2. Resolve the per-agent LLM client + failover chain (shared with executeJob
  //    via resolveAgentLlmClient so the chain logic can't drift — Guard 2).
  const resolved = await resolveAgentLlmClient(db, {
    llmKeyId: agentRow.llmKeyId,
    fallbackChain: agentRow.fallbackChain ?? null,
    model: agentRow.model ?? DEFAULT_MODEL,
  });
  if (!resolved.ok) {
    return {
      ok: false,
      error:
        resolved.reason === 'agent_no_llm_configured'
          ? 'agent_no_llm_configured'
          : 'llm_key_invalid',
    };
  }
  const llmClient = resolved.client;

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
  const deployment = await getDeploymentContext(db, entityId);
  const systemPrompt = await buildSystemPrompt(agent, db, {
    origin: 'dashboard',
    surface: 'chat',
    task: message,
    deployment,
  });

  // 4. Load recent history of THIS conversation (most recent N, chronological).
  //    CRITICAL: an assistant turn that ESCALATED (has a jobId) is replayed WITH
  //    its run_task tool call + a tool-result — not as a bare text ack. The chat
  //    persists only the text reply, so a naive history shows the agent "just
  //    acknowledging in prose"; a reasoning model (MiniMax M3) then reproduces
  //    that pattern and narrates the next action instead of calling run_task
  //    (measured: 2/6 escalation on a poisoned history vs 6/6 once escalations
  //    are shown faithfully). Reconstructing the tool call repairs the few-shot
  //    context so the escalation pattern stays visible.
  const rows = await db
    .select({
      role: chatMessages.role,
      content: chatMessages.content,
      jobId: chatMessages.jobId,
      jobTask: agentJobs.task,
      jobStatus: agentJobs.status,
      jobResult: agentJobs.result,
      jobError: agentJobs.error,
    })
    .from(chatMessages)
    .leftJoin(agentJobs, eq(chatMessages.jobId, agentJobs.id))
    .where(eq(chatMessages.conversationId, conversationId))
    .orderBy(desc(chatMessages.createdAt))
    .limit(HISTORY_LIMIT);
  const messages: ModelMessage[] = [];
  for (const r of rows.reverse()) {
    if (r.role === 'assistant' && r.jobId) {
      const toolCallId = `hist-${r.jobId}`;
      messages.push({
        role: 'assistant',
        content: [
          ...(r.content ? [{ type: 'text' as const, text: r.content }] : []),
          {
            type: 'tool-call' as const,
            toolCallId,
            toolName: 'run_task',
            input: { instruction: r.jobTask ?? '' },
          },
        ],
      });
      // The tool-result reflects the dispatched job's REAL current outcome, so
      // the orchestrator knows whether a prior delegation is done / running /
      // failed and what it produced — never a static "dispatched" that hides
      // completion and drives re-dispatch loops on sequential work.
      const outcome = buildDispatchOutput(r.jobStatus, r.jobResult, r.jobError);
      messages.push({
        role: 'tool',
        content: [
          {
            type: 'tool-result' as const,
            toolCallId,
            toolName: 'run_task',
            output: { type: 'text' as const, value: outcome },
          },
        ],
      });
    } else {
      messages.push({ role: r.role as 'user' | 'assistant', content: r.content });
    }
  }

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
  } catch (err) {
    // A provider may THROW when the model emits a tool call for a tool not in
    // this set (a phantom built-in). Log it (don't swallow blind — fail loud,
    // invariant 4) and fall through to the tool-free retry so conversation works.
    console.warn(`[run-chat-turn] tools call failed (${agentRow.slug}):`, (err as Error).message);
  }

  // 5b. ESCALATION RECOVERY. The model produced a reply but NO run_task call. A
  //     reasoning model (MiniMax M3) intermittently narrates an action without
  //     calling the tool. Since tool_choice can't be forced (404 on MiniMax),
  //     re-prompt ONCE: show it its own reply and have it either escalate or
  //     confirm it was conversation. Recovers the ~1-in-5 narration misses.
  if (!runTask && text) {
    try {
      const recheck = await llmClient.generateText({
        system: systemPrompt,
        messages: [
          ...messages,
          { role: 'assistant', content: text },
          { role: 'user', content: ESCALATION_RECHECK },
        ],
        tools: CHAT_TOOLS,
      });
      runTask = (recheck.toolCalls ?? []).find((tc) => tc.toolName === 'run_task');
    } catch {
      // Keep the original text reply — recovery is best-effort.
    }
  }

  // 6a. ESCALATION: the agent wants to act → spawn a real job (the unit of work).
  //     The spawned job runs the ROOT with its full toolset (delegating to
  //     sub-agents → the dispatch cards). The chat just shows its progress.
  if (runTask) {
    const instruction =
      String((runTask.input as { instruction?: unknown } | undefined)?.instruction ?? '').trim() ||
      message;
    // SAFETY NET against intent drift: the worker must always see the USER's
    // actual words, not only the orchestrator's framing. If the instruction did
    // not already carry them (Alfred reworded/compressed despite the steer), append
    // the user's exact message as the source of truth. Dedup when it's already in.
    const probe = message.trim().slice(0, 160);
    const workerContent =
      probe.length > 0 && !instruction.includes(probe)
        ? `${instruction}\n\n[User's exact request, verbatim — this is the source of truth; the line above is only framing]\n${message}`
        : instruction;
    const [job] = await db
      .insert(agentJobs)
      .values({
        entityId,
        agentId,
        status: 'pending',
        channel: 'dashboard',
        task: instruction,
        messages: [{ role: 'user', content: workerContent }],
      })
      .returning({ id: agentJobs.id });

    // The acknowledgment is the agent's OWN words (it's prompted to write a
    // one-liner when it escalates). If it wrote none, the runner stays SILENT
    // (invariant #2) — content is empty and the UI shows just the dispatch card
    // + the eventual job result, never a fabricated runner string.
    const reply = text;
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
