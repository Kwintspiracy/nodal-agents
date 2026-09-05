// conversation-feed.ts — le fil d'un travail, tel que la page de l'espace le
// dessine (plan « De la maquette au produit », P2).
//
// Pur : des lignes déjà lues (le job et ses messages, ses tool_calls, ses
// llm_calls, ses enfants) → une suite d'items. Aucune requête, aucun texte
// d'interface : le composant met les mots, ce module met la STRUCTURE — et il
// dispatche sur la CARTE persistée par P1 (`tool_calls.card`, `presented`),
// jamais sur le nom de l'outil.
//
// Ce que le fil montre, dans cet ordre :
//   request  — la demande, avec d'où elle vient (canal, automatisation)
//   turn     — un tour de l'agent : sa prose, puis ses actions — les mineures
//              repliées en un groupe (raisonnement, lectures, recherches,
//              accusés), les résultats en cartes (fichiers, table, terminal,
//              envoi, verdict, délégation)
//   note     — un rappel du runner à l'agent (les messages `user` qui suivent
//              la demande sont des nudges, jamais l'utilisateur)
//   history  — ce qui PRÉCÈDE la demande : l'historique d'une conversation que
//              le runner préfixe au transcript (thread-history.ts) — replié
//   child    — un travail confié à un autre agent, avec son propre fil
//   answer   — la réponse finale, quand le travail est terminé
//
// Lecteur des trois formats de message : `blocksFromContent` (JobMessages),
// réutilisé et non copié — plan, « ce qu'on garde ». Les parties `reasoning`
// (persistées par le runner, execute.ts) sont lues ici, en amont.

import { TOOL_CARDS, ToolCardPayloadSchema } from '@nodal-agents/shared';
import type { ToolCard, ToolCardPayload } from '@nodal-agents/shared';
import { blocksFromContent } from '@/components/JobMessages.tsx';

// ─── Entrées ──────────────────────────────────────────────────────────────────

export type FeedToolCallRow = {
  toolCallId: string | null;
  toolName: string;
  /** La carte DÉCLARÉE par l'outil (P1). null sur une ligne antérieure à 0092. */
  card: string | null;
  /** La charge utile présentée (P1). null : rien de présentable, l'écran dit « brut ». */
  presented: unknown;
  durationMs: number | null;
  turn: number | null;
  toolInput: unknown;
  toolOutput: string | null;
  createdAt: Date | null;
};

export type FeedLlmCallRow = {
  turn: number | null;
  source: string;
  modelEffective: string;
  provider: string;
  inputTokens: number | null;
  outputTokens: number | null;
  cachedTokens: number | null;
  cacheCreationTokens: number | null;
  costUsd: number | null;
  durationMs: number | null;
};

export type FeedChildJob = {
  id: string;
  agentName: string | null;
  agentSlug: string | null;
  status: string | null;
  task: string | null;
  result: string | null;
  error: string | null;
  createdAt: Date | null;
  completedAt: Date | null;
  /** Le fil de l'enfant, si l'appelant l'a construit (récursion à sa main). */
  feed?: ConversationFeed;
};

export type FeedJob = {
  id: string;
  task: string;
  channel: string;
  chatId: string | null;
  status: string | null;
  result: string | null;
  error: string | null;
  agentName: string | null;
  agentSlug: string | null;
  createdAt: Date | null;
  completedAt: Date | null;
  messages: unknown[];
  /** Provenance cron (trigger_context) — le nom de l'automatisation, s'il y en a une. */
  scheduleName: string | null;
  children: FeedChildJob[];
};

// ─── Sorties ──────────────────────────────────────────────────────────────────

export type Origin = {
  channel: string;
  scheduleName: string | null;
  chatId: string | null;
};

/** Ce qu'une action a donné, lu depuis la ligne d'audit — jamais deviné. */
export type StepOutcome = 'success' | 'error' | 'awaiting_approval' | 'blocked' | 'unknown';

export type Step =
  | {
      kind: 'reasoning';
      text: string;
    }
  | {
      kind: 'tool';
      toolName: string;
      toolCallId: string | null;
      /**
       * La carte persistée sur la ligne (P1). null : pas de ligne (l'outil n'est
       * pas passé par executeTool — return_result, assign_*) ou ligne
       * antérieure à 0092. L'écran montre alors le nom et la sortie brute.
       */
      card: ToolCard | null;
      /** La charge utile, VALIDÉE ; null si absente ou hors forme. */
      presented: ToolCardPayload | null;
      input: unknown;
      outputText: string | null;
      outcome: StepOutcome;
      durationMs: number | null;
    };

export type TurnBlock =
  | { kind: 'prose'; text: string }
  /** Des actions mineures, repliées : raisonnement, lectures, recherches, accusés, brut. */
  | { kind: 'steps'; steps: Step[] }
  /** Un résultat qui se montre : fichiers, table, terminal, envoi, verdict, délégation. */
  | { kind: 'card'; step: Extract<Step, { kind: 'tool' }> };

export type TurnUsage = {
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  cacheCreationTokens: number;
  costUsd: number | null;
  durationMs: number;
  calls: number;
};

export type FeedItem =
  | { kind: 'request'; text: string; origin: Origin; at: Date | null }
  | { kind: 'note'; text: string }
  | {
      kind: 'turn';
      /** Rang d'affichage, 1..n dans CE job. */
      index: number;
      /**
       * Le compteur `turn` du runner, celui de `llm_calls.turn` — lu sur la ligne
       * d'audit d'un appel du tour (`audit`), ou déduit du tour précédent quand
       * le tour n'a appelé aucun outil (`inferred`). Le runner avance ce
       * compteur avant chaque tentative LLM, y compris une tentative rejetée
       * sans message de l'agent : l'index d'affichage ne suffit pas.
       */
      turn: number;
      turnSource: 'audit' | 'inferred';
      agent: { name: string | null; slug: string | null };
      model: string | null;
      blocks: TurnBlock[];
      usage: TurnUsage | null;
    }
  /**
   * Ce qui précède la demande : l'historique d'une conversation (Telegram,
   * Slack…) que le runner préfixe au transcript (thread-history.ts) pour que
   * l'agent se souvienne. Ce n'est PAS ce job — le fil le montre replié, à part.
   */
  | { kind: 'history'; exchanges: Array<{ role: 'user' | 'agent'; text: string }> }
  | { kind: 'child'; job: FeedChildJob }
  | { kind: 'answer'; text: string }
  | { kind: 'failure'; text: string };

export type FeedTotals = {
  turns: number;
  toolCalls: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  cacheCreationTokens: number;
  /** null quand AUCUN appel n'a de coût connu — jamais un 0 qui voudrait dire « gratuit ». */
  costUsd: number | null;
  llmDurationMs: number;
  models: string[];
};

export type ConversationFeed = {
  items: FeedItem[];
  totals: FeedTotals;
};

// ─── Politique d'affichage : quelles cartes se montrent seules ───────────────
//
// Sur la CARTE, jamais sur le nom. Une lecture, une recherche, un accusé
// (`text`) et le brut restent des étapes repliées ; ce qui a produit quelque
// chose s'affiche.

export const STANDALONE_CARDS: ReadonlySet<ToolCard> = new Set<ToolCard>([
  'files',
  'table',
  'terminal',
  'sent',
  'checks',
  'delegation',
  'question',
]);

/** Le préfixe que le runner met devant ses rappels à l'agent (delivery / approval nudges). */
export const RUNNER_NOTE_PREFIX = '[système]';

/**
 * Une action se montre seule quand sa carte est une carte de résultat, que
 * l'appel a réussi, et que la charge utile a quelque chose à dessiner : une
 * table sans ligne ou une liste de fichiers vide restent des étapes — dire
 * « 0 souvenir » en carte pleine page serait du bruit, pas de l'information.
 */
export function showsAlone(step: Extract<Step, { kind: 'tool' }>): boolean {
  if (step.card === null || !STANDALONE_CARDS.has(step.card)) return false;
  if (step.outcome !== 'success') return false;
  const p = step.presented;
  if (p === null) return true; // carte de résultat sans charge : l'écran montre le brut, mais à sa place
  if (p.card === 'table') return p.tables.some((t) => t.rows.length > 0);
  if (p.card === 'files') return p.total > 0;
  return true;
}

// ─── Lecture des lignes ───────────────────────────────────────────────────────

function isToolCard(value: string | null): value is ToolCard {
  return value !== null && (TOOL_CARDS as readonly string[]).includes(value);
}

function parsePresented(value: unknown): ToolCardPayload | null {
  if (value === null || value === undefined) return null;
  const parsed = ToolCardPayloadSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/**
 * Le sort d'un appel, lu depuis ce que executeTool a écrit : une ligne
 * d'échec porte `{ outcome: 'error' | 'blocked' | 'awaiting_approval' }`, une
 * ligne de succès porte la sortie brute de l'outil.
 */
function outcomeOf(row: FeedToolCallRow | undefined): StepOutcome {
  if (!row || row.toolOutput === null) return 'unknown';
  try {
    const parsed = JSON.parse(row.toolOutput) as unknown;
    if (parsed && typeof parsed === 'object' && 'outcome' in parsed) {
      const o = (parsed as { outcome: unknown }).outcome;
      if (o === 'error' || o === 'blocked' || o === 'awaiting_approval') return o;
      if (o === 'success') return 'success';
    }
  } catch {
    // sortie non JSON : une chaîne brute, donc un succès textuel
  }
  return 'success';
}

type ReasoningPart = { type: 'reasoning'; text: string };

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  return blocksFromContent(withoutReasoning(content))
    .filter((b) => b.kind === 'text')
    .map((b) => b.text ?? '')
    .join('\n');
}

/** L'index du DERNIER message `user` dont le texte est exactement la tâche ; 0 sinon. */
function lastIndexOfTask(messages: readonly unknown[], task: string): number {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i] as { role?: unknown; content?: unknown };
    if (m.role === 'user' && typeof m.content === 'string' && m.content === task) return i;
  }
  return 0;
}

/** L'historique en échanges lisibles : qui a dit quoi, sans les résultats d'outils. */
function exchangesOf(
  messages: readonly unknown[],
): Array<{ role: 'user' | 'agent'; text: string }> {
  const out: Array<{ role: 'user' | 'agent'; text: string }> = [];
  for (const raw of messages) {
    const m = raw as { role?: unknown; content?: unknown };
    if (m.role !== 'user' && m.role !== 'assistant') continue;
    const text = textOf(m.content).trim();
    if (text === '') continue;
    out.push({ role: m.role === 'user' ? 'user' : 'agent', text });
  }
  return out;
}

/** Le contenu sans ses parties `reasoning` — blocksFromContent ne les connaît pas et les rendrait en texte JSON. */
function withoutReasoning(content: unknown): unknown {
  if (!Array.isArray(content)) return content;
  return content.filter(
    (p) => !(typeof p === 'object' && p !== null && (p as { type?: unknown }).type === 'reasoning'),
  );
}

function reasoningParts(content: unknown): string[] {
  if (!Array.isArray(content)) return [];
  return content
    .filter(
      (p): p is ReasoningPart =>
        typeof p === 'object' &&
        p !== null &&
        (p as { type?: unknown }).type === 'reasoning' &&
        typeof (p as { text?: unknown }).text === 'string',
    )
    .map((p) => p.text);
}

// ─── Le fil ───────────────────────────────────────────────────────────────────

export function buildConversationFeed(
  job: FeedJob,
  toolCalls: readonly FeedToolCallRow[],
  llmCalls: readonly FeedLlmCallRow[],
): ConversationFeed {
  const items: FeedItem[] = [];
  const origin: Origin = {
    channel: job.channel,
    scheduleName: job.scheduleName,
    chatId: job.chatId,
  };

  // Les lignes d'audit, par id d'appel ; et par nom pour les lignes anciennes
  // sans id (étape D, 2026-08), consommées dans l'ordre.
  const byCallId = new Map<string, FeedToolCallRow>();
  const byNameQueue = new Map<string, FeedToolCallRow[]>();
  for (const row of toolCalls) {
    if (row.toolCallId) byCallId.set(row.toolCallId, row);
    else {
      const q = byNameQueue.get(row.toolName) ?? [];
      q.push(row);
      byNameQueue.set(row.toolName, q);
    }
  }
  const rowFor = (toolCallId: string, toolName: string): FeedToolCallRow | undefined => {
    const direct = byCallId.get(toolCallId);
    if (direct) return direct;
    return byNameQueue.get(toolName)?.shift();
  };

  // Les appels LLM, par tour (le tour k = le k-ième message de l'agent).
  const usageByTurn = new Map<number, TurnUsage & { model: string | null }>();
  for (const call of llmCalls) {
    if (call.turn === null) continue;
    const u = usageByTurn.get(call.turn) ?? {
      inputTokens: 0,
      outputTokens: 0,
      cachedTokens: 0,
      cacheCreationTokens: 0,
      costUsd: null,
      durationMs: 0,
      calls: 0,
      model: null,
    };
    u.inputTokens += call.inputTokens ?? 0;
    u.outputTokens += call.outputTokens ?? 0;
    u.cachedTokens += call.cachedTokens ?? 0;
    u.cacheCreationTokens += call.cacheCreationTokens ?? 0;
    if (call.costUsd !== null) u.costUsd = (u.costUsd ?? 0) + call.costUsd;
    u.durationMs += call.durationMs ?? 0;
    u.calls += 1;
    u.model = call.modelEffective;
    usageByTurn.set(call.turn, u);
  }

  // La frontière : le message `user` qui EST la demande de ce job — le dernier
  // égal à `job.task` (l'historique préfixé peut contenir une demande identique
  // plus ancienne ; les messages `user` qui suivent la demande sont des rappels
  // du runner, jamais égaux à la tâche). Rien trouvé : tout est ce job.
  const boundary = lastIndexOfTask(job.messages, job.task);
  const before = job.messages.slice(0, boundary);
  const current = job.messages.slice(boundary);
  if (before.length > 0) items.push({ kind: 'history', exchanges: exchangesOf(before) });

  let turnIndex = 0;
  let lastTurn = 0;
  let sawRequest = false;
  let toolCallCount = 0;

  for (const raw of current) {
    const msg = raw as { role?: unknown; content?: unknown };
    const role = msg.role;

    if (role === 'user') {
      const text =
        typeof msg.content === 'string'
          ? msg.content
          : blocksFromContent(msg.content)
              .filter((b) => b.kind === 'text')
              .map((b) => b.text ?? '')
              .join('\n');
      if (!sawRequest) {
        sawRequest = true;
        items.push({ kind: 'request', text, origin, at: job.createdAt });
      } else {
        // Après la demande, un message `user` est un rappel du runner, pas
        // l'utilisateur — le fil le dit comme tel.
        items.push({ kind: 'note', text: text.replace(RUNNER_NOTE_PREFIX, '').trim() });
      }
      continue;
    }

    if (role === 'assistant') {
      turnIndex += 1;
      const blocks: TurnBlock[] = [];
      const prose = blocksFromContent(withoutReasoning(msg.content)).filter(
        (b) => b.kind === 'text',
      );
      for (const p of prose) {
        if (p.text && p.text.trim() !== '') blocks.push({ kind: 'prose', text: p.text });
      }

      // Les actions : le raisonnement d'abord (c'est ainsi qu'il a décidé),
      // puis les appels, dans l'ordre. Les mineures s'agrègent en un groupe ;
      // une carte le clôt.
      let pending: Step[] = [];
      const flush = (): void => {
        if (pending.length > 0) blocks.push({ kind: 'steps', steps: pending });
        pending = [];
      };
      const rowTurns: number[] = [];
      for (const text of reasoningParts(msg.content)) {
        pending.push({ kind: 'reasoning', text });
      }
      for (const b of blocksFromContent(withoutReasoning(msg.content))) {
        if (b.kind !== 'tool-call') continue;
        toolCallCount += 1;
        const toolName = b.toolName ?? 'unknown';
        const row = rowFor(b.toolCallId ?? '', toolName);
        if (row && row.turn !== null) rowTurns.push(row.turn);
        const card = row && isToolCard(row.card) ? row.card : null;
        const step: Extract<Step, { kind: 'tool' }> = {
          kind: 'tool',
          toolName,
          toolCallId: b.toolCallId ?? null,
          card,
          presented: row ? parsePresented(row.presented) : null,
          input: b.payload,
          outputText: row?.toolOutput ?? null,
          outcome: outcomeOf(row),
          durationMs: row?.durationMs ?? null,
        };
        if (showsAlone(step)) {
          flush();
          blocks.push({ kind: 'card', step });
        } else {
          pending.push(step);
        }
      }
      flush();

      const auditTurn = rowTurns[0];
      const turn = auditTurn ?? lastTurn + 1;
      const turnSource: 'audit' | 'inferred' = auditTurn !== undefined ? 'audit' : 'inferred';
      lastTurn = turn;
      const u = usageByTurn.get(turn);
      items.push({
        kind: 'turn',
        index: turnIndex,
        turn,
        turnSource,
        agent: { name: job.agentName, slug: job.agentSlug },
        model: u?.model ?? null,
        blocks,
        usage: u
          ? {
              inputTokens: u.inputTokens,
              outputTokens: u.outputTokens,
              cachedTokens: u.cachedTokens,
              cacheCreationTokens: u.cacheCreationTokens,
              costUsd: u.costUsd,
              durationMs: u.durationMs,
              calls: u.calls,
            }
          : null,
      });
      continue;
    }

    // role === 'tool' : les résultats sont déjà joints aux appels par tool_calls.
  }

  // Les enfants : chacun un groupe, à la fin du fil (leur place exacte dans le
  // tour parent viendra avec la ligne d'audit de assign_*, qui n'existe pas
  // encore — execute() lève avant d'écrire).
  for (const child of job.children) items.push({ kind: 'child', job: child });

  if (job.status === 'completed' && job.result && job.result.trim() !== '') {
    items.push({ kind: 'answer', text: job.result });
  } else if ((job.status === 'failed' || job.status === 'cancelled') && (job.error || job.result)) {
    items.push({ kind: 'failure', text: job.error ?? job.result ?? '' });
  }

  // Les totaux, depuis les appels LLM du job (la barre d'état de P4 s'en sert).
  const models = new Set<string>();
  const totals: FeedTotals = {
    turns: turnIndex,
    toolCalls: toolCallCount,
    inputTokens: 0,
    outputTokens: 0,
    cachedTokens: 0,
    cacheCreationTokens: 0,
    costUsd: null,
    llmDurationMs: 0,
    models: [],
  };
  for (const call of llmCalls) {
    totals.inputTokens += call.inputTokens ?? 0;
    totals.outputTokens += call.outputTokens ?? 0;
    totals.cachedTokens += call.cachedTokens ?? 0;
    totals.cacheCreationTokens += call.cacheCreationTokens ?? 0;
    if (call.costUsd !== null) totals.costUsd = (totals.costUsd ?? 0) + call.costUsd;
    totals.llmDurationMs += call.durationMs ?? 0;
    models.add(call.modelEffective);
  }
  totals.models = [...models];

  return { items, totals };
}
