// chat/run-chat-turn.ts — generate one in-app chat reply WITHOUT creating a job.
//
// Conversation-first (V4): a chat turn is NOT a job. This produces a pure-text
// reply using the agent's personality + AUTO-INJECTED memory (recall is free —
// `buildSystemPrompt` splices the entity's durable facts into the prompt) +
// the recent history of THIS conversation.
//
// ONE tool is exposed, and one only: `run_task` (see `CHAT_TOOLS` below), which
// is how a chat turn escalates to a real `agent_jobs` row. These lines said the
// opposite — « no tools are exposed, so nothing here can create a job » — long
// after the escalation shipped, and a comment that states a rule gets read as
// one (revue Codex de la dette de la PR #73, passe 3).

import { eq, and, asc, desc, sql } from '@nodal-agents/db';
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
import { TITLE_SYSTEM_PROMPT, cleanTitle, titlePrompt } from './conversation-title.ts';
import type { ChatSurfaceToolName } from '@nodal-agents/catalog';
import { z } from 'zod';
import type { ModelMessage } from 'ai';
import type { RunnerDeps } from '../deps.ts';
import { stoppedReplyNote, untilStopped } from './turn-stop.ts';

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
// Au-delà, on cesse de redemander un titre au modèle. La relance existe parce
// qu'un seul essai rate — le modèle rend un paragraphe, `cleanTitle` le refuse,
// et la conversation garde la première phrase de la personne POUR TOUJOURS
// (14 fils du propriétaire dans ce cas le 18/09). Elle est bornée pour la
// raison inverse : un fil dont le modèle ne sait décidément pas tirer un titre
// ne doit pas payer un appel de plus à chaque tour, indéfiniment.
const TITLE_RETRY_MAX_MESSAGES = 10;

/**
 * Le titre PROVISOIRE : la première phrase de la personne, tronquée.
 *
 * Écrit dès le premier message — il faut bien quelque chose dans la liste
 * pendant que la réponse se génère — et RECALCULÉ plus tard pour reconnaître
 * un titre que le modèle n'a jamais remplacé. Une seule fonction pour les deux
 * usages : deux formules qui divergent d'un caractère feraient passer un titre
 * provisoire pour un titre choisi, et il ne serait plus jamais renommé.
 */
function provisionalTitle(userMessage: string): string {
  const t = userMessage.trim();
  return t.slice(0, TITLE_MAX) + (t.length > TITLE_MAX ? '…' : '');
}

// The ONE tool the chat agent gets: escalate to a real job. Pure conversation +
// memory recall need no tool (recall is auto-injected). When the user asks for
// an ACTION, the agent calls run_task → we spawn an agent_jobs row that the
// agent then executes with its full toolset (delegating to sub-agents as
// needed). That spawned job — not the chat turn — is the unit that does work.
//
// Les NOMS viennent du catalogue (`chatSurfaceToolNames`), et le `Record`
// ci-dessous les impose : une clé en trop ou en moins ne compile pas. Deux
// suites de tests lisaient cette liste en la recopiant à la main, et un second
// outil les aurait fait rougir à tort (constat mineur 1 de la revue C de la
// PR #73, issue #211).
export const CHAT_TOOLS: Record<
  ChatSurfaceToolName,
  { description: string; inputSchema: z.ZodTypeAny }
> = {
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
  | {
      ok: true;
      reply: string;
      spawnedJobId?: string;
      /**
       * `reply` est-elle EXACTEMENT ce que `onTextDelta` a dit ? (#152)
       *
       * Vrai quand le texte rendu est celui qui est passé par le flux. Faux
       * partout ailleurs : aucun flux demandé, `streamText` qui casse et laisse
       * la relance sans outils livrer la réponse d'un bloc, ou un flux resté
       * vide dont cette même relance a pris le relais. L'appelant n'a donc pas
       * à deviner si ce qu'il a montré mot à mot est bien la réponse.
       */
      streamed?: boolean;
      /** La personne a arrêté ce tour (#456) : `reply` est ce qui avait été écrit. */
      stopped?: boolean;
    }
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
  /** Réponse arrêtée par la personne (#456) : le modèle doit le savoir. */
  stopped?: boolean;
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
  const content =
    r.role === 'assistant' && r.stopped === true
      ? `${truncateFn(r.content)}

${stoppedReplyNote()}`
      : truncateFn(r.content);
  return [{ role: r.role as 'user' | 'assistant', content }];
}

export async function runChatTurn(opts: {
  deps: RunnerDeps;
  entityId: string;
  agentId: string;
  conversationId: string;
  message: string;
  /**
   * Le texte de la réponse, fragment par fragment, pendant qu'il arrive (#152).
   *
   * Absent — le cas de `/api/chat` — le tour se joue exactement comme avant :
   * un seul appel `generateText`, la réponse d'un bloc. Présent, SEUL l'appel
   * PRINCIPAL passe en flux : ni le recheck d'escalade, ni la relance sans
   * outils, ni la génération du titre n'appellent ce rappel. Ce ne sont pas la
   * réponse, et les diffuser montrerait du texte que personne n'a écrit pour
   * être lu.
   *
   * Ce que ce rappel reçoit n'est jamais la vérité finale : la réponse rendue
   * par ce tour, et la ligne écrite en base, le sont. Un flux coupé en route
   * retombe dans la relance sans outils plus bas, dont le texte n'est PAS
   * diffusé — l'appelant remplace donc ce qu'il a accumulé par `reply`, sans
   * quoi un texte tronqué passerait pour la réponse (invariant #4).
   */
  onTextDelta?: (delta: string) => void;
  /**
   * Le Stop de la personne (#456), posé par `withChatTurnStop`. Déclenché,
   * il coupe l'appel en cours : ce qui a été écrit est gardé, suivi de
   * `chat_messages.stopped`, et rien d'autre ne se joue — ni recheck
   * d'escalade, ni relance sans outils, ni job lancé.
   */
  abortSignal?: AbortSignal;
}): Promise<ChatTurnResult> {
  const { deps, entityId, agentId, conversationId, message, onTextDelta, abortSignal } = opts;
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
      // L'agent DU fil : un tour ne s'écrit que dans la conversation de son
      // propre agent (revue Codex, passe 29).
      agentId: conversations.agentId,
      // Le projet courant du fil (P6) : il suit le job qu'une escalade `run_task`
      // crée, pour que le travail naisse déjà dans le bon dossier.
      currentProjectId: conversations.currentProjectId,
    })
    .from(conversations)
    .where(and(eq(conversations.id, conversationId), eq(conversations.entityId, entityId)))
    .limit(1);
  if (!conv) return { ok: false, error: 'conversation_not_found' };

  // 1a-bis. L'agent demandé DOIT être celui de la conversation.
  //
  // Vérifier l'entité ne suffisait pas : l'appelant web résolvait le ROOT
  // COURANT, si bien qu'après un changement de ROOT, répondre dans l'ancien
  // fil de A écrivait des messages de B et exécutait B avec l'historique de A.
  // L'appelant est corrigé, mais la garde vit ICI aussi — et AVANT le moindre
  // insert : un tour mal adressé ne doit laisser aucune trace (invariant #4).
  if (conv.agentId !== agentId) return { ok: false, error: 'conversation_agent_mismatch' };

  // 1b. Persist the user turn IMMEDIATELY — before the (slower) LLM resolution +
  // system-prompt build — so it's visible the instant the user navigates back to
  // /chat, even while the reply is still generating. (Single writer = runner.)
  await db
    .insert(chatMessages)
    .values({ entityId, agentId, conversationId, role: 'user', content: message });
  // First message names the conversation (cheap auto-title; LLM summary later).
  if (!conv.title) {
    await db
      .update(conversations)
      .set({ title: provisionalTitle(message) })
      .where(eq(conversations.id, conversationId));
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
      ...(abortSignal ? { abortSignal } : {}),
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
      // 0100 — un tour de chat n'a pas de job : c'est la CONVERSATION qui
      // rattache ses jetons et son coût au fil qui les montre.
      conversationId,
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
  const conversation = await loadConversationContext(db, conversationId, { task: message });
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
      stopped: chatMessages.stopped,
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
  // Le texte qu'on va rendre est-il celui qui est sorti par le flux ? Posé ici
  // à faux, tenu vrai par le seul chemin qui le diffuse, et remis à faux par
  // la relance sans outils qui, elle, ne diffuse rien.
  let streamed = false;
  // Ce que le flux a déjà dit, gardé si la personne arrête le tour (#456).
  let partial = '';
  /**
   * Le tour arrêté par la personne : ce qui a été écrit, suivi de la ligne de
   * plateforme, devient la réponse de ce tour. Aucun job, aucun recheck,
   * aucune relance — la personne a demandé que ça s'arrête.
   */
  const keepStoppedReply = async (): Promise<ChatTurnResult> => {
    const reply = partial.trim();
    await db.insert(chatMessages).values({
      entityId,
      agentId,
      conversationId,
      role: 'assistant',
      content: reply,
      stopped: true,
    });
    await db
      .update(conversations)
      .set({ updatedAt: new Date() })
      .where(eq(conversations.id, conversationId));
    return { ok: true, reply, streamed: true, stopped: true };
  };
  try {
    if (onTextDelta) {
      // Le MÊME appel, dit au fur et à mesure (#152). `streamText` rend son
      // résultat tout de suite ; le texte complet et les appels d'outils ne
      // sont connus qu'une fois le flux consommé, d'où les `await` après la
      // boucle. L'escalade se lit donc exactement comme sur l'autre chemin.
      const result = llmClient.streamText({
        system: systemPrompt,
        messages,
        tools: CHAT_TOOLS,
        ...(abortSignal ? { abortSignal } : {}),
      });
      for await (const delta of untilStopped(result.textStream, abortSignal)) {
        partial += delta;
        onTextDelta(delta);
      }
      if (abortSignal?.aborted) return await keepStoppedReply();
      text = ((await result.text) ?? '').trim();
      runTask = ((await result.toolCalls) ?? []).find((tc) => tc.toolName === 'run_task');
      // Après les `await` : une erreur en cours de flux passe par le catch, et
      // le texte de ce tour viendra alors d'ailleurs.
      streamed = true;
    } else {
      const response = await llmClient.generateText({
        system: systemPrompt,
        messages,
        tools: CHAT_TOOLS,
      });
      text = (response.text ?? '').trim();
      runTask = (response.toolCalls ?? []).find((tc) => tc.toolName === 'run_task');
    }
  } catch (err) {
    // Stop pendant l'appel : ce n'est pas une panne, rien ne se rejoue.
    if (abortSignal?.aborted) return await keepStoppedReply();
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
  //
  //     ET ELLE NE REJOUE PAS LE TOUR ENTIER. Mesuré sur la base de Quentin le
  //     09/09 : cette relance envoyait le prompt système COMPLET et tout
  //     l'historique, soit ~9 300 jetons — autant que la réponse elle-même, pour
  //     un tour où l'utilisateur avait dit bonjour. Trois appels par tour, 18 500
  //     jetons d'entrée, et la moitié pour reposer une question dont la réponse
  //     ne dépend d'aucun d'eux.
  //
  //     La question est LOCALE : « ma réponse promettait-elle une action ? ». Ni
  //     les skills injectés, ni les descriptions de sous-agents, ni les faits de
  //     mémoire, ni les tours précédents n'aident à y répondre — seuls comptent
  //     la demande de l'utilisateur (que `run_task` doit transmettre fidèlement)
  //     et la réponse qu'on relit. C'est donc tout ce qu'on envoie.
  //
  //     Le prompt système est retiré, pas allégé : le cadre nécessaire tient dans
  //     la consigne, et l'outil porte sa propre description. Un système partiel
  //     aurait été un troisième prompt à tenir cohérent avec les deux autres.
  if (!runTask && text) {
    try {
      const recheck = await llmClient.generateText(
        {
          messages: [
            { role: 'user', content: message },
            { role: 'assistant', content: text },
            { role: 'user', content: ESCALATION_RECHECK },
          ],
          tools: CHAT_TOOLS,
        },
        abortSignal ? { abortSignal } : undefined,
      );
      runTask = (recheck.toolCalls ?? []).find((tc) => tc.toolName === 'run_task');
    } catch {
      // Keep the original text reply — recovery is best-effort.
    }
  }

  // Stop pendant la relance d'escalade (#456, revue Codex passe 8) : rien ne
  // se lance après le Stop, pas même un job que la relance aurait demandé.
  if (abortSignal?.aborted) return await keepStoppedReply();

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
    const [ackRow] = await db
      .insert(chatMessages)
      .values({
        entityId,
        agentId,
        conversationId,
        role: 'assistant',
        content: reply,
        jobId: job?.id ?? null,
      })
      .returning({ id: chatMessages.id });
    await db
      .update(conversations)
      .set({ updatedAt: new Date() })
      .where(eq(conversations.id, conversationId));

    // Un tour qui escalade est un tour comme un autre pour la LISTE : il n'a
    // jamais été nommé, et c'est précisément la forme des fils que le
    // propriétaire lisait par leur première phrase (« Crée-moi une app assez
    // simple dans laquelle je peux écrire, »). Les mêmes gardes s'appliquent —
    // titre encore provisoire, conversation courte — donc aucun appel de plus
    // sur un fil déjà nommé.
    await nameConversationWhileProvisional({
      db,
      conversationId,
      userMessage: message,
      agentReply: reply,
      generate: (system, prompt) =>
        llmClient.generateText({ system, messages: [{ role: 'user', content: prompt }] }),
    });

    // Stop arrivé PENDANT la création du job (#456, revue Codex de #459) : le
    // job est né mais ne partira pas. Il est marqué annulé — il paraît donc
    // tel quel dans Runs —, la réponse est marquée arrêtée, et l'appelant ne
    // reçoit aucun job à lancer.
    if (abortSignal?.aborted) {
      if (job?.id) {
        await db
          .update(agentJobs)
          .set({ status: 'cancelled', updatedAt: new Date() })
          .where(eq(agentJobs.id, job.id));
      }
      if (ackRow?.id) {
        await db.update(chatMessages).set({ stopped: true }).where(eq(chatMessages.id, ackRow.id));
      }
      return { ok: true, reply, streamed, stopped: true };
    }

    return { ok: true, reply, spawnedJobId: job?.id, streamed };
  }

  // 6b. Pure conversation — persist the assistant turn. No job created.
  //     If the model produced neither text nor a run_task call (e.g. it tried a
  //     tool that isn't available on this surface), force a plain-text answer
  //     with a tool-free retry so the user always gets a reply. The LLM still
  //     speaks — we never fabricate text (invariant #2).
  let replyText = text;
  if (!replyText) {
    try {
      const retry = await llmClient.generateText(
        { system: systemPrompt, messages },
        abortSignal ? { abortSignal } : undefined,
      );
      if (abortSignal?.aborted) return await keepStoppedReply();
      replyText = (retry.text ?? '').trim();
      // Cette réponse-là n'est jamais passée par le flux : ce qui a pu être
      // montré mot à mot, s'il y a eu quoi que ce soit, n'était pas elle.
      streamed = false;
    } catch {
      if (abortSignal?.aborted) return await keepStoppedReply();
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

  // Le titre DÉFINITIF, tiré de l'échange entier — après la réponse, jamais
  // avant : le nommer coûte un appel, et l'utilisateur attend sa réponse, pas
  // son titre. Un échec ne remonte pas : le titre provisoire (sa première
  // phrase) reste, ce qui est le pire cas acceptable.
  await nameConversationWhileProvisional({
    db,
    conversationId,
    userMessage: message,
    agentReply: replyText,
    generate: (system, prompt) =>
      llmClient.generateText({ system, messages: [{ role: 'user', content: prompt }] }),
  });

  return { ok: true, reply: replyText, streamed };
}

/**
 * La conversation porte-t-elle encore un titre PROVISOIRE ?
 *
 * Trois formes, et trois seulement : rien, « Untitled », ou la première phrase
 * de la personne tronquée par `provisionalTitle`. Tout le reste est un titre
 * que le modèle a rendu — ou que quelqu'un a écrit — et il ne se remplace
 * jamais : le relire pour le réécrire ferait changer un fil de nom sous les
 * yeux de son lecteur.
 */
async function titleIsProvisional(
  db: Parameters<typeof loadConversationContext>[0],
  conversationId: string,
  title: string,
): Promise<boolean> {
  const t = title.trim();
  if (t === '' || t === 'Untitled') return true;
  const [first] = await db
    .select({ content: chatMessages.content })
    .from(chatMessages)
    .where(and(eq(chatMessages.conversationId, conversationId), eq(chatMessages.role, 'user')))
    .orderBy(asc(chatMessages.createdAt))
    .limit(1);
  // Sans premier message, rien ne dit à quoi ressemblerait le provisoire : on
  // ne touche pas au titre plutôt que de deviner (invariant #4).
  if (first === undefined) return false;
  return t === provisionalTitle(first.content);
}

/**
 * Nomme la conversation d'après l'échange, TANT QU'ELLE N'A PAS DE NOM.
 *
 * Le nommage tournait au seul premier échange (`count === 2`). Un essai unique
 * suffit quand il réussit ; quand il rate — le modèle rend un paragraphe,
 * `cleanTitle` le refuse, l'appel échoue — la conversation gardait sa première
 * phrase brute jusqu'à la fin de sa vie, et c'est exactement ce que le
 * propriétaire lisait dans sa liste (18/09).
 *
 * Il tourne donc à CHAQUE tour, sous deux gardes qui le bornent : le titre est
 * encore provisoire (voir `titleIsProvisional` — un titre obtenu ne se
 * remplace jamais), et la conversation compte au plus
 * `TITLE_RETRY_MAX_MESSAGES` messages.
 */
async function nameConversationWhileProvisional(input: {
  db: Parameters<typeof loadConversationContext>[0];
  conversationId: string;
  userMessage: string;
  agentReply: string;
  generate: (system: string, prompt: string) => Promise<{ text?: string }>;
}): Promise<void> {
  try {
    const [count] = await input.db
      .select({ n: sql<number>`count(*)` })
      .from(chatMessages)
      .where(eq(chatMessages.conversationId, input.conversationId));
    if (Number(count?.n ?? 0) > TITLE_RETRY_MAX_MESSAGES) return;

    // Le titre TEL QU'IL EST EN BASE. Celui lu au début du tour ne convient
    // pas : ce même tour vient peut-être d'y écrire le provisoire.
    const [row] = await input.db
      .select({ title: conversations.title })
      .from(conversations)
      .where(eq(conversations.id, input.conversationId))
      .limit(1);
    if (row === undefined) return;
    if (!(await titleIsProvisional(input.db, input.conversationId, row.title ?? ''))) return;

    const out = await input.generate(
      TITLE_SYSTEM_PROMPT,
      titlePrompt({ userMessage: input.userMessage, agentReply: input.agentReply }),
    );
    const title = cleanTitle(out.text ?? '');
    if (title === null) return;
    await input.db
      .update(conversations)
      .set({ title })
      .where(eq(conversations.id, input.conversationId));
  } catch (err) {
    // Jamais bloquant : la conversation garde son titre provisoire.
    console.warn('[run-chat-turn] auto-title failed:', (err as Error).message);
  }
}
