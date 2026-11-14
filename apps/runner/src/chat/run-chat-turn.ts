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

import { eq, and, asc, desc, sql, cancelJobs } from '@nodal-agents/db';
import {
  agents,
  chatMessages,
  conversations,
  agentJobs,
  startConversationTurn,
} from '@nodal-agents/db';
import {
  buildSystemPrompt,
  assertTurnToolCallBudget,
  ToolCallLimitExceededError,
} from '@nodal-agents/orchestration';
import type { Agent, AgentId, EntityId } from '@nodal-agents/orchestration';
import { resolveAgentLlmClient } from '../job/resolve-llm.ts';
import { makeLlmCallSink } from '../llm/call-sink.ts';
import { runCliRuntimeChatTurn } from '../cli-runtime/run-chat.ts';
import { chatTurnOrigin } from './turn-origin.ts';
import { getDeploymentContext } from '../job/deployment.ts';
import {
  BUDGET_CHARS as HISTORY_BUDGET_CHARS,
  datedTurn,
  truncate as truncateHeadTail,
} from '../job/thread-history.ts';
import { loadExchangeRecords } from '../job/exchange-record.ts';
import { conversationMoments, reachedThePerson, taskEndedAt } from '../job/conversation-moments.ts';
import { quotedLines } from '../job/tool-acts.ts';
import { loadConversationContext } from '../job/conversation-id.ts';
import { TITLE_SYSTEM_PROMPT, cleanTitle, titlePrompt } from './conversation-title.ts';
import type { ChatSurfaceToolName } from '@nodal-agents/catalog';
import { z } from 'zod';
import type { ModelMessage } from 'ai';
import { recheckNarratedAction } from '../llm/action-recheck.ts';
import type { RunnerDeps } from '../deps.ts';
import { cutReplyNote, stoppedReplyNote } from './turn-stop.ts';
import { LLMOutputLimitError, LLMTimeoutError, type LlmTimeoutReason } from '@nodal-agents/llm';
import {
  formatLocalTime,
  handoffNote,
  openingMessages,
  runnerRecordMessage,
  type BrakeStop,
  type ReplyRendering,
} from '@nodal-agents/shared';
import { watchCallProgress } from '../job/call-progress.ts';

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
      'The user’s message reaches the job exactly as they wrote it, with the earlier turns of ' +
      'this conversation: the platform passes them on, you do not retype them. `instruction` ' +
      'is YOUR NOTE beside them, and the job reads it as yours, not as the user’s: leave it ' +
      'empty when their words say it all. Do NOT add scope, a method, a check or a delivery ' +
      'the user did not ask for — that is the worker’s own judgment.\n' +
      'Never decline an action the user asks for — escalate it here. For plain conversation or ' +
      'recalling facts, reply in text instead (do not call this).\n' +
      'While a job launched from this conversation is still running, a call starts a reply turn ' +
      'that sees that job and decides: pass the person’s words on to it, stop it, or start ' +
      'other work beside it. The message is never assumed to be about the running job.',
    inputSchema: z.object({ instruction: z.string().max(16000) }),
  },
};

/**
 * Les étapes de PRÉPARATION d'un tour, dans l'ordre où `runChatTurn` les
 * franchit avant d'appeler le fournisseur (#1063). Un appelant qui veut savoir
 * où passe l'attente avant le premier mot du modèle les reçoit par `onPhase`.
 * Chaque nom dit la fin d'une étape :
 *
 *   - `turnStarted` : le tour a passé la file de la conversation et commence ;
 *   - `userMessageSaved` : le message de la personne est rangé ;
 *   - `llmResolved` : le client du modèle (clé, chaîne de secours) est résolu ;
 *   - `contextLoaded` : le déploiement et le fil (projet courant) sont lus ;
 *   - `promptBuilt` : le prompt système est construit, mémoire comprise ;
 *   - `historyLoaded` : l'historique du fil est lu et rogné ;
 *   - `providerRequest` : l'appel part vers le fournisseur.
 *
 * Un tour qui ne va pas jusqu'au fournisseur (agent en runtime CLI, agent
 * introuvable) s'arrête à la dernière étape franchie : les suivantes ne sont
 * jamais annoncées, jamais inventées.
 */
export const CHAT_TURN_PHASES = [
  'turnStarted',
  'userMessageSaved',
  'llmResolved',
  'contextLoaded',
  'promptBuilt',
  'historyLoaded',
  'providerRequest',
] as const;
export type ChatTurnPhase = (typeof CHAT_TURN_PHASES)[number];

export type ChatTurnResult =
  | {
      ok: true;
      reply: string;
      spawnedJobId?: string;
      /**
       * `reply` est-elle EXACTEMENT ce que `onTextDelta` a dit ? (#152)
       *
       * Vrai quand le texte rendu est celui qui est passé par le flux. Faux
       * partout ailleurs : aucun flux demandé, un flux qui casse avant d'écrire
       * et laisse la relance sans outils livrer la réponse d'un bloc, un flux
       * resté vide dont cette même relance a pris le relais, ou un modèle qui
       * ne sait pas diffuser (#458). L'appelant n'a donc pas
       * à deviner si ce qu'il a montré mot à mot est bien la réponse.
       */
      streamed?: boolean;
      /** La personne a arrêté ce tour (#456) : `reply` est ce qui avait été écrit. */
      stopped?: boolean;
      /**
       * Une horloge (#458), ou le frein d'urgence sur un tour de CLI (#494), a
       * coupé ce tour : `reply` est ce qui avait été écrit.
       */
      cutReason?: LlmTimeoutReason | BrakeStop;
    }
  | {
      ok: false;
      error: string;
      /**
       * Une horloge a coupé l'appel AVANT tout texte visible (#484) :
       * `error` vaut `llm_cut` et ce champ dit laquelle.
       */
      cutReason?: LlmTimeoutReason;
    };

/**
 * The words the runner says of a launched job's outcome, by status: the ONE
 * source of them, for the `run_task` result of a job still under its launch
 * and for the record of a job's end (#1078). `null` while the job runs.
 */
function outcomeStatusLine(status: string | null): string | null {
  if (status === 'completed') return 'Completed.';
  if (status === 'failed') {
    return 'FAILED — report this to the user with the reason; do not silently retry.';
  }
  if (status === 'cancelled') return 'Cancelled by the user.';
  return null;
}

/** What a finished job produced: its result, or its failure reason. A cancel has none. */
function outcomeBody(
  status: string | null,
  result: string | null,
  error: string | null,
): string | null {
  const r = (result ?? '').trim();
  if (status === 'completed') return r || '(no textual output was recorded)';
  if (status === 'failed') return r || error || 'unknown error';
  return null;
}

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
 *
 * Since #1078 this is the result of a job that has NO end to place: still
 * running, or finished with no stored end time. A job that ended is told at
 * the time it ended (`taskEndRecord`).
 */
function buildDispatchOutput(
  status: string | null,
  result: string | null,
  error: string | null,
): string {
  const line = outcomeStatusLine(status);
  // pending / processing / awaiting_approval / awaiting_delegation
  if (line === null) {
    return 'Still running — no result yet. Do NOT dispatch it again; wait for it to finish.';
  }
  const body = outcomeBody(status, result, error);
  return body === null
    ? line
    : `${line}
${body}`;
}

/**
 * The `run_task` result under the turn that launched a job which has ENDED
 * (#1078): its outcome is not here, it is a moment of its own, at the time the
 * job ended (`taskEndRecord`).
 */
export const LAUNCHED_OUTPUT =
  'Launched. Its outcome is recorded further down, at the time it ended.';

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
  /** Quand le message a été écrit : un message de la personne rejoué en porte la date (#650). */
  createdAt: Date | null;
  /** Réponse arrêtée par la personne (#456) : le modèle doit le savoir. */
  stopped?: boolean;
  /** Réponse coupée par une horloge (#458) : le modèle doit le savoir aussi. */
  cutReason?: string | null;
  jobId: string | null;
  /** La note que ce tour avait écrite à côté des mots de la personne (handoff.ts). */
  jobHandoffNote: string | null;
  jobStatus: string | null;
  jobResult: string | null;
  jobError: string | null;
  /** When the launched job was created: the launch the record of its end names (#1078). */
  jobCreatedAt: Date | null;
  /** When the launched job ended, as stored at its end (`agent_jobs.completed_at`, #1078). */
  jobCompletedAt: Date | null;
  /** What was announced to the person when the job ended (#967), if anything. */
  jobSpokenAnnouncement: string | null;
}

/** When the job this row launched ended, if it has an end to place (#1078, `taskEndedAt`). */
function endOf(r: HistoryRow): Date | null {
  return r.jobId ? taskEndedAt({ status: r.jobStatus, completedAt: r.jobCompletedAt }) : null;
}

/**
 * Build one "block" (1 or 2 ModelMessages) for a single history row. Nothing
 * the runner wrote lands in an assistant part (#562): ledger lines and the
 * stop note travel in the `run_task` result, the notes on a plain reply in a
 * `[système]` message after it. For a job that ENDED (#1078), the `run_task`
 * result only says it was launched: its outcome, ledger lines and stop note
 * are the record of its end (`taskEndRecord`), at the time it ended.
 * `truncateFn` is a parameter — NOT always `truncateHeadTail` — so the caller
 * controls whether per-message truncation applies (F-12, audit #2 round 2:
 * it's a last resort when the budget is exceeded even after dropping older
 * turns, never an unconditional per-turn cap; pass the identity function to
 * keep a turn fully intact).
 *
 * `ledgerLines` — the runner's record of the launched job (#1075,
 * exchange-record.ts): every tool it called, the head of each result of a
 * tool not declared read-only, and its delegations with their own acting
 * calls (2026-07-12 incident — see task-ledger.ts). The job's own `result` is
 * the agent's PROSE, not a structural record of what it did; these lines are
 * appended after that prose so a later turn can't be told "no, I never did
 * it" when the job's tools say otherwise. Appended AFTER truncation of the
 * dispatch output itself so the bounded record can never be the part that
 * gets chopped.
 *
 * `timezone` — the one the system prompt states "now" in: each message of the
 * person carries its own date in it (#650, `datedTurn`, the same form as the
 * channels' replay in thread-history.ts). The agent's replies stay undated.
 */
function buildHistoryBlock(
  r: HistoryRow,
  truncateFn: (s: string) => string,
  ledgerLines: readonly string[],
  timezone: string,
): ModelMessage[] {
  if (r.role === 'assistant' && r.jobId) {
    const toolCallId = `hist-${r.jobId}`;
    const ackText = r.content ? truncateFn(r.content) : '';
    let outputValue = LAUNCHED_OUTPUT;
    // A job that ended is told at the time it ended (#1078, `taskEndRecord`):
    // its outcome, its record and the stop note go there, not here.
    if (endOf(r) === null) {
      const dispatchOutput = truncateFn(buildDispatchOutput(r.jobStatus, r.jobResult, r.jobError));
      const withLedger =
        ledgerLines.length > 0 ? `${dispatchOutput}\n\n${ledgerLines.join('\n')}` : dispatchOutput;
      // Un Stop après l'escalade (#456) marque l'accusé `stopped` et annule le
      // job : sans la note, le modèle suivant lirait une annulation ordinaire,
      // pas la personne qui a arrêté (revue Codex de #459, passe 4).
      outputValue = r.stopped === true ? `${withLedger}\n\n${stoppedReplyNote()}` : withLedger;
    }
    return [
      {
        role: 'assistant',
        content: [
          ...(ackText ? [{ type: 'text' as const, text: ackText }] : []),
          {
            type: 'tool-call' as const,
            toolCallId,
            toolName: 'run_task',
            // Ce que le front avait écrit : sa note. Les mots de la personne
            // sont déjà là, dans ses messages rejoués juste avant.
            input: { instruction: truncateFn(r.jobHandoffNote ?? '') },
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
  const note =
    r.role !== 'assistant'
      ? null
      : r.stopped === true
        ? stoppedReplyNote()
        : r.cutReason
          ? cutReplyNote()
          : null;
  // La note est du runner : elle suit la réponse dans un message à part, marqué
  // `[système]`, jamais collée dans la bouche de l'agent (#562 — un modèle
  // continue ce qu'il a écrit, et il avait « écrit » les notes du runner).
  const reply: ModelMessage = {
    role: r.role as 'user' | 'assistant',
    content:
      r.role === 'user'
        ? datedTurn(truncateFn(r.content), sentAt(r), timezone)
        : truncateFn(r.content),
  };
  return note ? [reply, { role: 'user', content: note }] : [reply];
}

function sentAt(r: HistoryRow): Date {
  if (!r.createdAt) throw new Error('chat history: a chat_messages row has no created_at');
  return r.createdAt;
}

/**
 * The END of a launched job, as a moment of the conversation (#1078): a runner
 * record (#562) placed at the time the job ended, never in the agent's mouth.
 *
 *   [<end time>] The task launched at <launch time> ended. <status line>
 *   > <its result, or its failure reason, line by line>
 *   <its record (#1075), one line per entry>
 *   <the stop note, when the person stopped the reply that launched it>
 *   [Announced to the person when it ended]   (when a stored fact says so)
 *   > <what was announced, line by line>
 *
 * The first line is the runner's, dated as a message of the person is
 * (`datedTurn`), with the status words of `outcomeStatusLine`. The result is
 * DATA: every line of it starts with the quote mark (`quotedLines`), which no
 * line the runner writes starts with, so stored text cannot open a line that
 * reads as the runner's. The last-resort truncation applies to it as it did in
 * the `run_task` result.
 */
function taskEndRecord(
  r: HistoryRow,
  endedAt: Date,
  truncateFn: (s: string) => string,
  ledgerLines: readonly string[],
  timezone: string,
): ModelMessage {
  if (!r.jobCreatedAt) throw new Error(`chat history: agent_jobs ${r.jobId} has no created_at`);
  const status = outcomeStatusLine(r.jobStatus);
  if (status === null) throw new Error(`chat history: agent_jobs ${r.jobId} has not ended`);
  const body = outcomeBody(r.jobStatus, r.jobResult, r.jobError);
  return runnerRecordMessage([
    datedTurn(
      `The task launched at ${formatLocalTime(timezone, r.jobCreatedAt)} ended. ${status}`,
      endedAt,
      timezone,
    ),
    ...(body === null ? [] : quotedLines(truncateFn(body))),
    ...ledgerLines,
    ...(r.stopped === true ? [stoppedReplyNote()] : []),
    ...reachedThePerson(r.jobSpokenAnnouncement, truncateFn),
  ]) as ModelMessage;
}

/**
 * Un appel du tour a été COUPÉ (#484) : une horloge, ou un flux rompu, avant
 * tout texte gardé. Le tour échoue en disant la coupure et sa raison, `llm_cut`
 * + `cutReason`, quel que soit l'appel qu'elle frappe : la réponse diffusée ou
 * la relance sans outils (revue Nodal de #623 : la relance la disait
 * `llm_error`, et l'écran peignait « pas de réponse » là où l'appel avait été
 * coupé). `null` pour toute autre erreur.
 */
function failedOnCut(
  err: unknown,
  which: string,
  agentSlug: string,
): { ok: false; error: 'llm_cut'; cutReason: LlmTimeoutReason } | null {
  if (!(err instanceof LLMTimeoutError)) return null;
  console.warn(`[run-chat-turn] ${which} cut by ${err.reason} before any text (${agentSlug})`);
  return { ok: false, error: 'llm_cut', cutReason: err.reason };
}

/**
 * Un appel du tour qui PROPOSAIT des outils a été refusé : il s'est arrêté sur
 * le plafond de jetons de sortie (#554, refusé par le client), ou il porte plus
 * d'appels que le budget d'un tour (#564, `runTaskOf`). Le tour en a trois (la
 * réponse, la relance d'escalade, la réponse après un `run_task` refusé) et la
 * règle est la même pour chacun : le tour échoue avec le code du refus. Aucune
 * relance ne le rattrape, ni ne garde la réponse d'avant : ce serait un nouvel
 * essai, que rien ici ne décide, et un tour présenté comme réussi (revue Codex
 * de #555, P1 ×2). `null` pour toute autre erreur, que l'appelant traite comme
 * avant.
 */
function failedOnRefusedTurn(
  err: unknown,
  which: string,
  agentSlug: string,
): { ok: false; error: string } | null {
  if (!(err instanceof LLMOutputLimitError) && !(err instanceof ToolCallLimitExceededError)) {
    return null;
  }
  console.warn(`[run-chat-turn] ${which} refused, ${err.code} (${agentSlug}):`, err.message);
  return { ok: false, error: err.code };
}

/**
 * Le `run_task` d'une réponse, après la règle du tour (#564, revue Codex de
 * #568, passe 4) : la même que la boucle des jobs, `assertTurnToolCallBudget`,
 * avant d'agir sur quoi que ce soit. Le chat n'exécute que le premier appel,
 * mais un tour de 51 appels est dégénéré, et le premier ne vaut pas mieux que
 * les autres. Lève `ToolCallLimitExceededError`, que `failedOnRefusedTurn` lit.
 */
function runTaskOf<T extends { toolName: string }>(response: {
  toolCalls?: readonly T[] | undefined;
}): T | undefined {
  const calls = response.toolCalls ?? [];
  assertTurnToolCallBudget(calls.length);
  return calls.find((tc) => tc.toolName === 'run_task');
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
   * Le texte de la réponse est FIXÉ (#943) : rappelé une fois, juste avant la
   * relecture d'escalade, qui ne change jamais ce texte (elle ne peut qu'y
   * ajouter un `run_task`), et avant le titre de la conversation. `streamed`
   * dit si ce texte est celui que `onTextDelta` a dit. Un appelant qui DIT la
   * réponse la finit ici, pendant que la relecture tourne : le premier son
   * n'attend pas un appel de modèle qui ne change pas ce qui est dit.
   *
   * Pas rappelé quand le tour s'arrête avant (Stop, coupure) ou échoue : c'est
   * le résultat du tour qui le dit, comme toujours. Absent — le chat écrit —,
   * rien ne change.
   */
  onReplyText?: (reply: { text: string; streamed: boolean }) => void;
  /**
   * Le Stop de la personne (#456), posé par `withChatTurnStop`. Déclenché,
   * il coupe l'appel en cours : ce qui a été écrit est gardé, suivi de
   * `chat_messages.stopped`, et rien d'autre ne se joue — ni recheck
   * d'escalade, ni relance sans outils, ni job lancé.
   */
  abortSignal?: AbortSignal;
  /**
   * La personne a DIT ce message (#941) : `message` est sa transcription, et
   * `durationMs` la durée de ce qu'elle a dit. Le tour reste le même tour —
   * mêmes outils (`run_task` seul), même historique, même remise — avec deux
   * faits de plus : le message de la personne est rangé comme dit, avec sa
   * durée, et la réponse sera ENTENDUE (`ReplyRendering` 'spoken'), pour ce
   * tour comme pour le job qu'il lance. Absent : un message tapé, lu.
   */
  spoken?: { durationMs: number };
  /**
   * Annonce chaque étape de préparation franchie (`CHAT_TURN_PHASES`, #1063).
   * Une mesure, rien d'autre : ce rappel ne change ni l'ordre des appels ni ce
   * qui est dit, et sa valeur ne se lit jamais pour décider quoi que ce soit.
   * Absent, rien ne change.
   */
  onPhase?: (phase: ChatTurnPhase) => void;
}): Promise<ChatTurnResult> {
  const {
    deps,
    entityId,
    agentId,
    conversationId,
    message,
    onTextDelta,
    onReplyText,
    abortSignal,
    spoken,
    onPhase,
  } = opts;
  const db = deps.db;
  onPhase?.('turnStarted');
  const replyRendering: ReplyRendering = spoken ? 'spoken' : 'text';

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
      // Où vit le fil (#945) : le tableau de bord ou un appareil. C'est
      // l'ORIGINE du tour et du job qu'il lance (chat/turn-origin.ts).
      channel: conversations.channel,
      chatId: conversations.chatId,
    })
    .from(conversations)
    .where(and(eq(conversations.id, conversationId), eq(conversations.entityId, entityId)))
    .limit(1);
  if (!conv) return { ok: false, error: 'conversation_not_found' };
  const origin = chatTurnOrigin(conv);
  // Un fil de canal de messagerie a ses tours sur la plateforme, en jobs : un
  // tour de chat n'y est jamais écrit, et AVANT le moindre insert (inv. #4).
  if (!origin) return { ok: false, error: 'conversation_not_chat' };

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
  await db.insert(chatMessages).values({
    entityId,
    agentId,
    conversationId,
    role: 'user',
    content: message,
    ...(spoken ? { spokenMs: spoken.durationMs } : {}),
  });
  // First message names the conversation (cheap auto-title; LLM summary later).
  if (!conv.title) {
    await db
      .update(conversations)
      .set({ title: provisionalTitle(message) })
      .where(eq(conversations.id, conversationId));
  }
  onPhase?.('userMessageSaved');

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
      replyRendering,
      origin: origin.channel,
      ...(abortSignal ? { abortSignal } : {}),
    });
  }

  // 2. Resolve the per-agent LLM client + failover chain (shared with executeJob
  //    via resolveAgentLlmClient so the chain logic can't drift — Guard 2).
  //
  //    L'effort de CE tour (#977) : un tour dont la réponse sera entendue prend
  //    le réglage « Reasoning when spoken to » de l'agent, un tour tapé son
  //    Reasoning. Les deux sont rangés, aucun ne se déduit de l'autre. Le
  //    client sert tout le tour — réponse, relecture d'escalade, relance sans
  //    outils, titre —, qui pense donc d'un seul effort ; le job que le tour
  //    lance (`execute.ts`) résout le sien, avec le Reasoning de l'agent.
  const resolved = await resolveAgentLlmClient(
    db,
    {
      entityId: agentRow.entityId ?? null,
      llmKeyId: agentRow.llmKeyId,
      fallbackChain: agentRow.fallbackChain ?? null,
      model: agentRow.model ?? DEFAULT_MODEL,
      reasoningEffort:
        (replyRendering === 'spoken' ? agentRow.spokenReasoningEffort : agentRow.reasoningEffort) ??
        null,
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
  onPhase?.('llmResolved');

  // 3. System prompt — memory is AUTO-INJECTED here (recall is free). The
  //    origin (the dashboard, or a device, #945) job-context steers the agent
  //    to reply in plain text.
  const deployment = await getDeploymentContext(db, entityId);
  // Le fil et son projet courant (P6). Chargé APRÈS l'insert du tour utilisateur
  // (1b ci-dessus) — d'où le « moins un » dans le compte des tours précédents,
  // qui vit dans `loadConversationContext`.
  const conversation = await loadConversationContext(db, conversationId, { task: message });
  onPhase?.('contextLoaded');
  const systemPrompt = await buildSystemPrompt(agent, db, {
    origin: origin.channel,
    surface: 'chat',
    task: message,
    deployment,
    replyRendering,
    ...(conversation ? { conversation } : {}),
  });
  onPhase?.('promptBuilt');

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
      createdAt: chatMessages.createdAt,
      stopped: chatMessages.stopped,
      cutReason: chatMessages.cutReason,
      jobId: chatMessages.jobId,
      jobHandoffNote: agentJobs.handoffNote,
      jobStatus: agentJobs.status,
      jobResult: agentJobs.result,
      jobError: agentJobs.error,
      jobCreatedAt: agentJobs.createdAt,
      jobCompletedAt: agentJobs.completedAt,
      jobSpokenAnnouncement: agentJobs.spokenAnnouncement,
    })
    .from(chatMessages)
    .leftJoin(agentJobs, eq(chatMessages.jobId, agentJobs.id))
    .where(eq(chatMessages.conversationId, conversationId))
    .orderBy(desc(chatMessages.createdAt))
    .limit(HISTORY_CANDIDATE_LIMIT);

  // Build one "block" (1 or 2 ModelMessages) per row, so the budget trim
  // below can drop a whole block at a time — never split an escalation's
  // tool-call from its tool-result. `truncateFn` is a parameter (not always
  // `truncateHeadTail`) — see the round-2 fix below: per-message truncation
  // is a LAST RESORT, not an unconditional per-turn cap (F-12, audit #2
  // round 2 — an unconditional cap chopped a single large paste mid-turn
  // even when the whole conversation fit comfortably under budget).
  //
  // The runner's record of each launched job rides in its `run_task` result,
  // which the budget does not count (`totalHistoryChars`): the trim is the
  // same with or without it, so the records are read AFTER it, for the turns
  // it keeps only.
  //
  // The END of a launched job (#1078) is not counted either: the trim runs on
  // the rows alone, exactly as before the end moved out of the `run_task`
  // result, and an end is built only for a launching row the trim kept. A
  // trimmed launch takes its end with it.
  const chronologicalRows = rows.reverse();
  let remainingRows = chronologicalRows;
  let blocks = remainingRows.map((r) => buildHistoryBlock(r, (s) => s, [], deployment.timezone));

  // Drop the OLDEST blocks (front of the chronological array) until the
  // total size is under budget — the same char-budget-as-token-proxy
  // approach as thread-history.ts's loadThreadHistory. Always keep at least
  // the single most recent turn — it's never simply dropped, only (as a
  // last resort below) truncated.
  while (blocks.length > 1 && totalHistoryChars(blocks) > HISTORY_BUDGET_CHARS) {
    blocks = blocks.slice(1);
    remainingRows = remainingRows.slice(1);
  }

  // The record of each launched job (#1075, exchange-record.ts): its tools,
  // what those that act returned, its delegations — `create_task` and in line
  // (`assign_*`). The in-line ones were first wired on `loadThreadHistory`
  // only, not here (revue Codex, 27/08): the surface where the owner talks to
  // agents most. One builder for every replay path since #1075.
  const records = await loadExchangeRecords(
    db,
    remainingRows.map((r) => r.jobId),
  );
  // Last resort: per-message head+tail truncation only if what's left STILL
  // exceeds the budget (e.g. the single most recent turn is itself gigantic).
  // A conversation that fits under budget as-is keeps every turn intact,
  // however large a single message is.
  const truncateFn =
    totalHistoryChars(blocks) > HISTORY_BUDGET_CHARS ? truncateHeadTail : (s: string) => s;
  // The moments of the conversation in the order they happened (#1078,
  // conversation-moments.ts): each kept row at the time it was written, and the
  // end of each job a kept row launched at the time it ended. The message being
  // answered is the last row, written by this turn (step 1b): it is not a
  // moment of the history, it stays LAST, and a job that ended after it was
  // written comes just before it.
  const ledgerOf = (r: HistoryRow) => records.get(r.jobId ?? '') ?? [];
  const answered = remainingRows.slice(-1);
  const moments = conversationMoments(remainingRows.slice(0, -1), (r) => ({
    writtenAt: r.createdAt,
    endedAt: endOf(r),
  }));
  const messages: ModelMessage[] = [
    ...moments.flatMap((m) =>
      m.kind === 'row'
        ? buildHistoryBlock(m.row, truncateFn, ledgerOf(m.row), deployment.timezone)
        : [taskEndRecord(m.row, m.endedAt, truncateFn, ledgerOf(m.row), deployment.timezone)],
    ),
    ...answered.flatMap((r) => buildHistoryBlock(r, truncateFn, ledgerOf(r), deployment.timezone)),
  ];
  onPhase?.('historyLoaded');

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
  // Ce que le flux a déjà dit, gardé si le tour s'arrête avant sa fin (#456, #458).
  let partial = '';
  /**
   * Le tour qui s'arrête avant sa fin : ce qui a été écrit devient la réponse
   * de ce tour, et la raison est un FAIT posé sur la ligne (`stopped` pour le
   * Stop de la personne, `cutReason` pour une horloge), que l'écran dit.
   * Aucun job, aucun recheck, aucune relance.
   */
  const keepPartialReply = async (
    fact: { stopped: true } | { cutReason: LlmTimeoutReason },
  ): Promise<ChatTurnResult> => {
    // Le flux remplit `partial` au fil de l'eau ; le chemin sans flux reçoit
    // sa réponse entière d'un coup dans `text`. Un Stop pendant la relance
    // d'escalade ne doit perdre ni l'un ni l'autre (revue Codex de #459, passe 3).
    const reply = (partial.trim() !== '' ? partial : text).trim();
    await db.insert(chatMessages).values({
      entityId,
      agentId,
      conversationId,
      role: 'assistant',
      content: reply,
      ...fact,
    });
    await db
      .update(conversations)
      .set({ updatedAt: new Date() })
      .where(eq(conversations.id, conversationId));
    return { ok: true, reply, streamed: true, ...fact };
  };
  const keepStoppedReply = (): Promise<ChatTurnResult> => keepPartialReply({ stopped: true });
  try {
    // Le fournisseur est appelé dans la ligne qui suit, par l'une ou l'autre voie.
    onPhase?.('providerRequest');
    if (onTextDelta) {
      // Le MÊME appel que celui des jobs, dit au fur et à mesure (#152, #458) :
      // sous les deux horloges de silence et le filet d'une heure, tracé dans
      // `llm_calls`, avec le retry et le failover du client. Chaque fragment
      // passe à la page pendant que le modèle l'écrit. Un modèle qui ne sait
      // pas diffuser (appels d'outils lus dans son texte) répond d'un bloc :
      // aucun fragment, et `streamed` reste faux.
      // #484 : le chat dit lui aussi ce que son appel produit, par le même
      // battement que la boucle des jobs.
      const production = watchCallProgress((faits) =>
        console.warn(`[run-chat-turn] llm_call_progress ${agentRow.slug} ${JSON.stringify(faits)}`),
      );
      let response: Awaited<ReturnType<typeof llmClient.generateText>>;
      try {
        response = await llmClient.generateText(
          { system: systemPrompt, messages, tools: CHAT_TOOLS },
          {
            streamed: true,
            onTextDelta: (delta) => {
              partial += delta;
              onTextDelta(delta);
            },
            onProgress: production.onProgress,
            ...(abortSignal ? { abortSignal } : {}),
          },
        );
      } finally {
        production.stop();
      }
      if (abortSignal?.aborted) return await keepStoppedReply();
      text = (response.text ?? '').trim();
      runTask = runTaskOf(response);
      streamed = partial !== '';
    } else {
      const response = await llmClient.generateText(
        { system: systemPrompt, messages, tools: CHAT_TOOLS },
        // Le chemin de secours (`/api/chat`) s'arrête lui aussi (#456).
        abortSignal ? { abortSignal } : undefined,
      );
      text = (response.text ?? '').trim();
      runTask = runTaskOf(response);
    }
  } catch (err) {
    // Stop pendant l'appel : ce n'est pas une panne, rien ne se rejoue.
    if (abortSignal?.aborted) return await keepStoppedReply();
    // Une horloge a coupé une réponse qui avait commencé à s'écrire (#458) :
    // la personne a vu ce texte arriver, il reste la réponse de ce tour. Le
    // rejouer sans outils l'effacerait pour une autre réponse, écrite de zéro.
    // Rien d'écrit : c'est une panne comme une autre, la relance ci-dessous.
    if (err instanceof LLMTimeoutError && partial.trim() !== '') {
      console.warn(
        `[run-chat-turn] reply cut by ${err.reason} after ${String(partial.length)} chars (${agentRow.slug})`,
      );
      return await keepPartialReply({ cutReason: err.reason });
    }
    const capped = failedOnRefusedTurn(err, 'reply', agentRow.slug);
    if (capped) return capped;
    // Coupé AVANT tout texte (#484, revue Codex passe 3) : ce n'est pas un
    // outil fantôme, et la relance sans outils ci-dessous n'a pas à le
    // rattraper. Un `run_task` fini dans le flux a été jeté avec lui ; une
    // relance privée de `run_task` ne pourrait que dire « c'est lancé » sans
    // qu'aucun job n'existe. Le tour échoue, en disant la coupure — comme un
    // job coupé (invariant #4).
    const cut = failedOnCut(err, 'reply', agentRow.slug);
    if (cut) return cut;
    // A provider may THROW when the model emits a tool call for a tool not in
    // this set (a phantom built-in). Log it (don't swallow blind — fail loud,
    // invariant 4) and fall through to the tool-free retry so conversation works.
    console.warn(`[run-chat-turn] tools call failed (${agentRow.slug}):`, (err as Error).message);
  }

  // 5b. ESCALATION RECOVERY. The model produced a reply but NO run_task call. A
  //     reasoning model (MiniMax M3) intermittently narrates an action without
  //     calling the tool, ~1 turn in 5. Since tool_choice is never forced
  //     (#600), the reply is re-read ONCE (llm/action-recheck.ts): the model
  //     either escalates or confirms it was conversation. The job loop no
  //     longer re-reads its replies (#886); this one stays until it is
  //     measured.
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
  //
  //     Elle relit la réponse FINALE en prose du tour, quelle qu'elle soit : la
  //     première, celle qui suit un run_task refusé, celle de la relance sans
  //     outils. UNE fois par tour, jamais en boucle (`relu`).
  let relu = false;
  const relireUneFois = async (): Promise<ChatTurnResult | null> => {
    if (relu || runTask || !text) return null;
    relu = true;
    try {
      const recheck = await recheckNarratedAction(llmClient, {
        request: message,
        reply: text,
        // Son relevé est vide, et c'est exact (llm/action-recheck.ts) : une
        // réponse qui a appelé `run_task` n'est jamais relue (`runTask`
        // ci-dessus), et aucun autre outil ne tourne avant la relance.
        tools: CHAT_TOOLS,
        ...(abortSignal ? { abortSignal } : {}),
      });
      runTask = runTaskOf(recheck);
    } catch (err) {
      if (abortSignal?.aborted) return await keepStoppedReply();
      // Toute panne, plafond de sortie et relance dégénérée (plus d'appels que
      // la règle du tour n'en admet, levée par `runTaskOf`) compris (PR #604) :
      // la relance n'est qu'un filet. Elle est abandonnée, aucun de ses appels
      // n'est exécuté, et la réponse (déjà partie en flux, peut-être) reste la
      // réponse du tour. La réponse elle-même garde la règle #564.
      console.warn(
        `[run-chat-turn] escalation recheck failed (${agentRow.slug}):`,
        (err as Error).message,
      );
    }
    // Stop pendant la relance d'escalade (#456, revue Codex passe 8) : rien ne
    // se lance après le Stop, pas même un job que la relance aurait demandé.
    if (abortSignal?.aborted) return await keepStoppedReply();
    return null;
  };

  // 6b (relance sans outils). Le modèle n'a écrit ni texte ni run_task (il a
  // tenté un outil absent de cette surface), ou son second run_task a été
  // refusé : il répond SANS outils, pour que la personne ait toujours une
  // réponse. Le modèle parle toujours, le runner n'invente rien (invariant #2).
  const repondreSansOutils = async (): Promise<ChatTurnResult | null> => {
    try {
      const retry = await llmClient.generateText(
        { system: systemPrompt, messages },
        abortSignal ? { abortSignal } : undefined,
      );
      if (abortSignal?.aborted) return await keepStoppedReply();
      text = (retry.text ?? '').trim();
      // Cette réponse-là n'est jamais passée par le flux : ce qui a pu être
      // montré mot à mot, s'il y a eu quoi que ce soit, n'était pas elle.
      streamed = false;
    } catch (err) {
      if (abortSignal?.aborted) return await keepStoppedReply();
      // Une coupure se dit comme au premier appel, jamais comme une panne.
      return (
        failedOnCut(err, 'tool-free retry', agentRow.slug) ?? { ok: false, error: 'llm_error' }
      );
    }
    return null;
  };

  // 5c. Chaque réponse part d'une réponse : sans texte ni appel, elle est
  //     redemandée sans outils ; en prose, elle est relue (une fois par tour).
  //
  //     UN TRAVAIL DU FIL COURT DÉJÀ (#453, #531). #453 refusait le `run_task`
  //     au modèle, et la précision de la personne n'atteignait jamais le
  //     travail en cours. Le `run_task` passe maintenant par le point de
  //     décision de toutes les entrées (`startConversationTurn`,
  //     @nodal-agents/db) : pendant qu'une tête du fil vit, il démarre un TOUR
  //     DE RÉPONSE qui voit ce qui tourne et décide — transmettre, arrêter,
  //     lancer autre chose. Le message n'est jamais présumé lié au travail en
  //     cours. AUCUNE échappatoire `alongside` (revue Codex de #453, passe 3) :
  //     c'est le tour de réponse, avec ses outils, qui juge.
  if (!runTask && !text) {
    const arret = await repondreSansOutils();
    if (arret) return arret;
  }
  // Le texte de la réponse ne bougera plus (#943) : la relecture ci-dessous
  // ne peut qu'ajouter un `run_task`.
  if (text) onReplyText?.({ text, streamed });
  const arretRelecture = await relireUneFois();
  if (arretRelecture) return arretRelecture;

  // 6a. ESCALATION: the agent wants to act → spawn a real job (the unit of work).
  //     The spawned job runs the ROOT with its full toolset (delegating to
  //     sub-agents → the dispatch cards). The chat just shows its progress.
  if (runTask) {
    // LA REMISE (handoff.ts). La tâche du job est le message de la personne,
    // tel qu'elle l'a écrit — comme sur tout canal : jamais le texte du modèle.
    // Les tours d'avant lui arrivent par l'historique du fil, comme sur tout
    // canal (thread-history.ts, `loadDashboardHistory`). Ce que le modèle écrit
    // dans `instruction` est sa note, que le travailleur lit après ces mots,
    // sous un cadre qui dit qu'elle n'est pas d'elle.
    const note = handoffNote(
      String((runTask.input as { instruction?: unknown } | undefined)?.instruction ?? ''),
      message,
    );
    // Tour de réponse ou tête d'un fil au repos : la décision de toute entrée
    // (#531), prise sous le verrou de la conversation.
    const turn = await startConversationTurn(db, {
      entityId,
      conversationId,
      start: {
        entityId,
        agentId,
        status: 'pending',
        // L'origine du tour (#945) : le tableau de bord, ou l'appareil dont
        // c'est le fil — son chat, pour que les questions, approbations et
        // l'annonce du job y reviennent.
        channel: origin.channel,
        ...origin.chat,
        task: message,
        handoffNote: note,
        // La réponse du travail se reçoit comme celle du tour qui l'a lancé :
        // dite pour un tour vocal, lue sinon (#941).
        replyRendering,
        // Jobs page grouping (migration 0059): this channel already has a
        // real conversation entity (the dashboard sidebar thread) — stamp
        // that id directly rather than re-deriving it from a gap heuristic.
        conversationId,
        // Le projet courant du fil (P6) : le travail escaladé naît dans le
        // dossier où cette conversation travaille, sans attendre qu'une
        // écriture l'y rattache.
        projectId: conv.currentProjectId,
        messages: openingMessages(message, note),
      },
    });
    const job = { id: turn.jobId };

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
        jobId: job.id,
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
        llmClient.generateText(
          { system, messages: [{ role: 'user', content: prompt }] },
          abortSignal ? { abortSignal } : undefined,
        ),
    });

    // Stop arrivé PENDANT la création du job (#456, revue Codex de #459) : le
    // job est né mais ne partira pas. Il est marqué annulé — il paraît donc
    // tel quel dans Runs —, la réponse est marquée arrêtée, et l'appelant ne
    // reçoit aucun job à lancer.
    if (abortSignal?.aborted) {
      // PORTE (a) (#944) : annulé et annoncé, comme tout job qui finit.
      await cancelJobs(db, { ids: [job.id] });
      if (ackRow?.id) {
        await db.update(chatMessages).set({ stopped: true }).where(eq(chatMessages.id, ackRow.id));
      }
      return { ok: true, reply, streamed, stopped: true };
    }

    return { ok: true, reply, spawnedJobId: job.id, streamed };
  }

  // 6b. Pure conversation — persist the assistant turn. No job created. A
  //     reply the tool-free retry could not produce either is an error: the
  //     runner never fabricates text (invariant #2).
  const replyText = text;
  if (!replyText) return { ok: false, error: 'empty_reply' };
  const [replyRow] = await db
    .insert(chatMessages)
    .values({ entityId, agentId, conversationId, role: 'assistant', content: replyText })
    .returning({ id: chatMessages.id });
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
    // Le Stop atteint aussi cet appel (revue Codex de #459, passe 2).
    generate: (system, prompt) =>
      llmClient.generateText(
        { system, messages: [{ role: 'user', content: prompt }] },
        abortSignal ? { abortSignal } : undefined,
      ),
  });

  // Stop pendant la génération du titre : la réponse était déjà écrite et
  // enregistrée ; elle est marquée arrêtée, et le tour le dit (#456).
  if (abortSignal?.aborted) {
    if (replyRow?.id) {
      await db.update(chatMessages).set({ stopped: true }).where(eq(chatMessages.id, replyRow.id));
    }
    return { ok: true, reply: replyText, streamed, stopped: true };
  }

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
