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
import { makeLlmCallSink } from '../llm/call-sink.ts';
import { runCliRuntimeChatTurn } from '../cli-runtime/run-chat.ts';
import { getDeploymentContext } from '../job/deployment.ts';
import {
  BUDGET_CHARS as HISTORY_BUDGET_CHARS,
  truncate as truncateHeadTail,
} from '../job/thread-history.ts';
import {
  loadTaskLedger,
  formatTaskLedgerLines,
  loadInlineDelegationLedger,
  formatInlineDelegationLines,
} from '../job/task-ledger.ts';
import { loadConversationContext } from '../job/conversation-id.ts';
import { z } from 'zod';
import type { ModelMessage } from 'ai';
import type { RunnerDeps } from '../deps.ts';

// F-12 (audit #2): the old HISTORY_LIMIT=20 bounded history by TURN COUNT, not
// size — 20 large turns (verbose replies, or several escalation blocks with
// job task/result text) could still overflow the model's context window,
// surfacing as an opaque llm_error after burning an LLM call. History is now
// bounded by a char budget (a token-count proxy, same approach and constant
// as thread-history.ts's loadThreadHistory) with head+tail per-message
// truncation, dropping the OLDEST turns first until under budget.
// HISTORY_CANDIDATE_LIMIT is just a raw-read safety cap on the SQL query —
// the real boundary is the budget trim below.
const HISTORY_CANDIDATE_LIMIT = 200;
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
 * and looped on sequential work (observed live on a sequential MCP chain). Now it
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

/**
 * Sum of text length across all history blocks (F-12, audit #2) — a char
 * count proxy for token budget, same convention as thread-history.ts's
 * `totalChars`. Only counts the parts that actually carry conversation text
 * (string content, `text` parts, and the escalation tool-call's
 * `instruction`); synthetic tool-result acks contribute negligible size and
 * are ignored, matching thread-history.ts's rationale.
 */
function totalHistoryChars(blocks: ReadonlyArray<ReadonlyArray<ModelMessage>>): number {
  let total = 0;
  for (const block of blocks) {
    for (const msg of block) {
      const content = msg.content;
      if (typeof content === 'string') {
        total += content.length;
        continue;
      }
      if (!Array.isArray(content)) continue;
      for (const p of content) {
        if (!p || typeof p !== 'object') continue;
        const part = p as { type?: unknown; text?: unknown; input?: unknown };
        if (part.type === 'text' && typeof part.text === 'string') {
          total += part.text.length;
        } else if (part.type === 'tool-call' && part.input && typeof part.input === 'object') {
          const instruction = (part.input as { instruction?: unknown }).instruction;
          if (typeof instruction === 'string') total += instruction.length;
        }
      }
    }
  }
  return total;
}

interface HistoryRow {
  role: string;
  content: string;
  jobId: string | null;
  jobTask: string | null;
  jobStatus: string | null;
  jobResult: string | null;
  jobError: string | null;
}

/**
 * Build one "block" (1 or 2 ModelMessages) for a single history row.
 * `truncateFn` is a parameter — NOT always `truncateHeadTail` — so the caller
 * controls whether per-message truncation applies (F-12, audit #2 round 2:
 * it's a last resort when the budget is exceeded even after dropping older
 * turns, never an unconditional per-turn cap; pass the identity function to
 * keep a turn fully intact).
 *
 * `ledgerLines` (2026-07-12 incident — see task-ledger.ts) — the REAL tool
 * calls made by any tasks this exchange's job delegated via `create_task`.
 * The job's own `result` (from deliverCompletedRoots' compileTaskResults) is
 * the delegated agent's PROSE, not a structural record of what it did; these
 * lines are appended after that prose so a later turn can't be told "no, I
 * never sent it" when a child job's tools_used says otherwise. Appended
 * AFTER truncation of the dispatch output itself so the bounded, already-
 * short ledger can never be the part that gets chopped.
 */
function buildHistoryBlock(
  r: HistoryRow,
  truncateFn: (s: string) => string,
  ledgerLines: readonly string[],
): ModelMessage[] {
  if (r.role === 'assistant' && r.jobId) {
    const toolCallId = `hist-${r.jobId}`;
    const ackText = r.content ? truncateFn(r.content) : '';
    const dispatchOutput = truncateFn(buildDispatchOutput(r.jobStatus, r.jobResult, r.jobError));
    const outputValue =
      ledgerLines.length > 0 ? `${dispatchOutput}\n\n${ledgerLines.join('\n')}` : dispatchOutput;
    return [
      {
        role: 'assistant',
        content: [
          ...(ackText ? [{ type: 'text' as const, text: ackText }] : []),
          {
            type: 'tool-call' as const,
            toolCallId,
            toolName: 'run_task',
            input: { instruction: truncateFn(r.jobTask ?? '') },
          },
        ],
      },
      // The tool-result reflects the dispatched job's REAL current outcome, so
      // the orchestrator knows whether a prior delegation is done / running /
      // failed and what it produced — never a static "dispatched" that hides
      // completion and drives re-dispatch loops on sequential work.
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result' as const,
            toolCallId,
            toolName: 'run_task',
            output: { type: 'text' as const, value: outputValue },
          },
        ],
      },
    ];
  }
  return [{ role: r.role as 'user' | 'assistant', content: truncateFn(r.content) }];
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
  const isRuntimeAgent = (agentRow.runtime ?? 'nodal') !== 'nodal';
  // A runtime agent (étape E) needs no Nodal LLM key — its brain is the CLI.
  if (!agentRow.llmKeyId && !isRuntimeAgent) {
    return { ok: false, error: 'agent_no_llm_configured' };
  }

  // 1a. Verify the conversation belongs to this entity (the sidebar entry).
  const [conv] = await db
    .select({
      id: conversations.id,
      title: conversations.title,
      // Le projet courant du fil (P6) : il suit le job qu'une escalade `run_task`
      // crée, pour que le travail naisse déjà dans le bon dossier.
      currentProjectId: conversations.currentProjectId,
    })
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

  // 1c. Runtime divert (étape E): the reply comes from the agent's Claude
  // Code session, resumed per conversation; the CLI's text is relayed
  // verbatim. Everything below (Nodal LLM client, system prompt, run_task)
  // does not apply to a runtime agent.
  // Normalised ONCE, above the runtime divert — both branches build the same
  // system prompt from it, so a field missing here is missing for both.
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

  if (isRuntimeAgent) {
    return await runCliRuntimeChatTurn({
      db,
      entityId,
      agentRow: {
        ...agent,
        runtime: agentRow.runtime ?? 'nodal',
        cliPermissions: agentRow.cliPermissions ?? null,
        cliDefaults: agentRow.cliDefaults ?? null,
      },
      conversationId,
      message,
    });
  }

  // 2. Resolve the per-agent LLM client + failover chain (shared with executeJob
  //    via resolveAgentLlmClient so the chain logic can't drift — Guard 2).
  const resolved = await resolveAgentLlmClient(
    db,
    {
      llmKeyId: agentRow.llmKeyId,
      fallbackChain: agentRow.fallbackChain ?? null,
      model: agentRow.model ?? DEFAULT_MODEL,
      reasoningEffort: agentRow.reasoningEffort ?? null,
    },
    undefined,
    // étape D: a chat turn makes up to 3 LLM calls (main, escalation recheck,
    // no-tools retry) — all previously invisible. One sink covers them all.
    makeLlmCallSink(db, {
      source: 'chat',
      entityId: agentRow.entityId ?? null,
      agentId: agentRow.id,
    }),
  );
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
  const deployment = await getDeploymentContext(db, entityId);
  // Le fil et son projet courant (P6). Chargé APRÈS l'insert du tour utilisateur
  // (1b ci-dessus) — d'où le « moins un » dans le compte des tours précédents,
  // qui vit dans `loadConversationContext`.
  const conversation = await loadConversationContext(db, conversationId);
  const systemPrompt = await buildSystemPrompt(agent, db, {
    origin: 'dashboard',
    surface: 'chat',
    task: message,
    deployment,
    ...(conversation ? { conversation } : {}),
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
    .limit(HISTORY_CANDIDATE_LIMIT);

  // Delegated-task visibility (2026-07-12 incident — see task-ledger.ts): one
  // batched query for every escalated job's own create_task fan-out, keyed by
  // jobId (= agent_tasks.root_job_id).
  const jobIds = rows.map((r) => r.jobId);
  const taskLedger = await loadTaskLedger(db, jobIds);
  // Et la délégation EN LIGNE (`assign_*`), qui ne passe PAS par `agent_tasks`.
  //
  // Le registre a d'abord été branché sur `loadThreadHistory` seulement, donc
  // sur Telegram, Slack et Discord — pas ici (revue Codex, 27/08). Or un tour
  // de chat dans le tableau de bord escalade par le même chemin : sans cette
  // ligne, un compte rendu de délégation inventé y restait indiscernable d'un
  // vrai. Exactement la panne que ce registre existe pour fermer, laissée
  // ouverte sur la surface où le propriétaire parle le plus à ses agents.
  const inlineLedger = await loadInlineDelegationLedger(db, jobIds);
  const ledgerLinesByJobId = new Map<string, string[]>();
  for (const jobId of new Set(jobIds.filter((id): id is string => !!id))) {
    const lines = [
      ...formatTaskLedgerLines(taskLedger.get(jobId) ?? []),
      ...formatInlineDelegationLines(inlineLedger.get(jobId) ?? []),
    ];
    if (lines.length > 0) ledgerLinesByJobId.set(jobId, lines);
  }

  // Build one "block" (1 or 2 ModelMessages) per row, so the budget trim
  // below can drop a whole block at a time — never split an escalation's
  // tool-call from its tool-result. `truncateFn` is a parameter (not always
  // `truncateHeadTail`) — see the round-2 fix below: per-message truncation
  // is a LAST RESORT, not an unconditional per-turn cap (F-12, audit #2
  // round 2 — an unconditional cap chopped a single large paste mid-turn
  // even when the whole conversation fit comfortably under budget).
  const chronologicalRows = rows.reverse();
  let remainingRows = chronologicalRows;
  let blocks = remainingRows.map((r) =>
    buildHistoryBlock(r, (s) => s, ledgerLinesByJobId.get(r.jobId ?? '') ?? []),
  );

  // Drop the OLDEST blocks (front of the chronological array) until the
  // total size is under budget — the same char-budget-as-token-proxy
  // approach as thread-history.ts's loadThreadHistory. Always keep at least
  // the single most recent turn — it's never simply dropped, only (as a
  // last resort below) truncated.
  while (blocks.length > 1 && totalHistoryChars(blocks) > HISTORY_BUDGET_CHARS) {
    blocks = blocks.slice(1);
    remainingRows = remainingRows.slice(1);
  }

  // Last resort: only rebuild with per-message head+tail truncation if
  // what's left STILL exceeds the budget (e.g. the single most recent turn
  // is itself gigantic). A conversation that fits under budget as-is keeps
  // every turn intact, however large a single message is.
  if (totalHistoryChars(blocks) > HISTORY_BUDGET_CHARS) {
    blocks = remainingRows.map((r) =>
      buildHistoryBlock(r, truncateHeadTail, ledgerLinesByJobId.get(r.jobId ?? '') ?? []),
    );
  }
  const messages: ModelMessage[] = blocks.flatMap((b) => b);

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
    // not already carry them (an orchestrator reworded/compressed despite the steer), append
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
        // Jobs page grouping (migration 0059): this channel already has a
        // real conversation entity (the dashboard sidebar thread) — stamp
        // that id directly rather than re-deriving it from a gap heuristic.
        conversationId,
        // Le projet courant du fil (P6) : le travail escaladé naît dans le
        // dossier où cette conversation travaille, sans attendre qu'une
        // écriture l'y rattache.
        projectId: conv.currentProjectId,
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
