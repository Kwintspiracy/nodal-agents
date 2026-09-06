// conversation-thread.ts — LE FIL D'UNE CONVERSATION (plan « De la maquette au
// produit », P7).
//
// P2 a donné le fil d'UN travail. Une conversation en contient plusieurs, et
// parfois aucun : sur le dashboard, un tour peut n'être qu'un échange de
// phrases, sans job. Ce module colle les deux dans une seule suite d'items —
// la même que `ConversationFeedView` dessine déjà, ce qui est tout l'intérêt :
// un fil Telegram et un fil du dashboard se lisent avec le même code.
//
// Pur, comme P2 : des fils de jobs DÉJÀ construits et des lignes déjà lues,
// aucune requête. Ce que ce module met en plus, c'est l'ORDRE et deux items
// que le job seul ne peut pas connaître :
//
//   produced — ce qui est sorti du chat à ce tour, et le projet où il vit ; le
//              verdict vient de `chat-or-work.ts`, sur les lignes du job ET de
//              ses descendants.
//   handoff  — la consigne que le chat a passée au travail. La demande de
//              l'utilisateur est déjà au-dessus, écrite de sa main ; la
//              reformulation de l'agent la répéterait. Elle est gardée quand
//              même, repliée, parce qu'elle dit ce que le travail a VRAIMENT
//              reçu — c'est souvent là qu'un malentendu se voit.
//
// Ce qui est RETIRÉ, et pourquoi : les items `history` des jobs. Le runner
// préfixe l'historique du fil au transcript pour que l'agent s'en souvienne
// (thread-history.ts) ; dans un fil de CONVERSATION, ces tours sont déjà
// au-dessus. Les garder afficherait deux fois la même chose.

import type { ConversationFeed, FeedItem, FeedTotals, Origin } from './conversation-feed.ts';
import type { ProductionVerdict } from './chat-or-work.ts';

export type ThreadProject = { id: string; name: string; path: string };

export type ThreadConversation = {
  id: string;
  channel: string;
  chatId: string | null;
  title: string;
  agentName: string | null;
  agentSlug: string | null;
  currentProject: ThreadProject | null;
};

/** Un tour du dashboard : `chat_messages`. Vide pour une conversation de canal. */
export type ThreadMessage = {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  /** Le travail que ce tour a déclenché, s'il en a déclenché un. */
  jobId: string | null;
  createdAt: Date | null;
};

/** Un job de TÊTE de la conversation, avec son fil P2 déjà assemblé. */
export type ThreadJob = {
  jobId: string;
  feed: ConversationFeed;
  createdAt: Date | null;
  verdict: ProductionVerdict;
  project: ThreadProject | null;
};

/** Ce que le fil dit quand le travail d'un tour n'existe plus en base. */
export const JOB_GONE_NOTE = '(job no longer available)';

function withoutHistory(items: readonly FeedItem[]): FeedItem[] {
  return items.filter((i) => i.kind !== 'history');
}

/**
 * Les items d'un job, tels qu'ils entrent dans un fil de conversation : sans
 * l'historique, et — sur le dashboard — avec la demande convertie en consigne
 * repliée. Sur un canal, la demande EST le message de l'utilisateur : elle
 * reste une demande.
 */
function jobItems(job: ThreadJob, asHandoff: boolean): FeedItem[] {
  const items = withoutHistory(job.feed.items);
  if (!asHandoff) return items;
  return items.map((i) => (i.kind === 'request' ? { kind: 'handoff' as const, text: i.text } : i));
}

function producedItem(job: ThreadJob): FeedItem | null {
  if (!job.verdict.isWork) return null;
  return {
    kind: 'produced',
    jobId: job.jobId,
    verdict: job.verdict,
    project: job.project,
  };
}

/** La somme des totaux des jobs — un tour de pure conversation n'en a pas. */
function sumTotals(jobs: readonly ThreadJob[]): FeedTotals {
  const models = new Set<string>();
  const totals: FeedTotals = {
    turns: 0,
    toolCalls: 0,
    inputTokens: 0,
    outputTokens: 0,
    cachedTokens: 0,
    cacheCreationTokens: 0,
    costUsd: null,
    llmDurationMs: 0,
    models: [],
  };
  for (const job of jobs) {
    const t = job.feed.totals;
    totals.turns += t.turns;
    totals.toolCalls += t.toolCalls;
    totals.inputTokens += t.inputTokens;
    totals.outputTokens += t.outputTokens;
    totals.cachedTokens += t.cachedTokens;
    totals.cacheCreationTokens += t.cacheCreationTokens;
    // null reste null tant qu'AUCUN job ne connaît son coût — jamais un 0 qui
    // voudrait dire « gratuit » (même règle que P2).
    if (t.costUsd !== null) totals.costUsd = (totals.costUsd ?? 0) + t.costUsd;
    totals.llmDurationMs += t.llmDurationMs;
    for (const m of t.models) models.add(m);
  }
  totals.models = [...models];
  return totals;
}

export function buildConversationThread(input: {
  conversation: ThreadConversation;
  /** Les tours du dashboard, chronologiques. `[]` pour une conversation de canal. */
  messages: readonly ThreadMessage[];
  /** Les jobs de TÊTE de la conversation, chronologiques. */
  jobs: readonly ThreadJob[];
}): ConversationFeed {
  const { conversation, messages, jobs } = input;
  const items: FeedItem[] = [];

  if (conversation.channel !== 'dashboard') {
    // Un fil de canal n'a pas de `chat_messages` : ses tours SONT ses jobs.
    for (const job of jobs) {
      items.push(...jobItems(job, false));
      const produced = producedItem(job);
      if (produced) items.push(produced);
    }
    return { items, totals: sumTotals(jobs) };
  }

  const byJobId = new Map(jobs.map((j) => [j.jobId, j]));
  const origin: Origin = { channel: 'dashboard', scheduleName: null, chatId: null };
  let turnIndex = 0;

  for (const message of messages) {
    if (message.role === 'user') {
      items.push({ kind: 'request', text: message.content, origin, at: message.createdAt });
      continue;
    }

    // Un tour d'assistant du chat n'a pas de ligne d'audit : son compteur de
    // tour n'existe pas (`turn: 0`, `inferred`) et il ne porte NI modèle NI
    // jetons — le chat écrit `chat_messages`, pas `llm_calls.turn`. Les
    // inventer les attribuerait à un appel qu'on n'a pas lu.
    const text = message.content.trim();
    if (text !== '') {
      turnIndex += 1;
      items.push({
        kind: 'turn',
        index: turnIndex,
        turn: 0,
        turnSource: 'inferred',
        agent: { name: conversation.agentName, slug: conversation.agentSlug },
        model: null,
        blocks: [{ kind: 'prose', text: message.content }],
        usage: null,
      });
    }

    if (message.jobId === null) continue;
    const job = byJobId.get(message.jobId);
    if (!job) {
      // Le job a été purgé (pas de clé étrangère depuis `chat_messages.job_id`
      // vers un job vivant : la colonne est SET NULL, mais un job supprimé
      // avant P6 a pu laisser l'id). Le fil le dit plutôt que de sauter le tour.
      items.push({ kind: 'note', text: JOB_GONE_NOTE });
      continue;
    }
    items.push(...jobItems(job, true));
    const produced = producedItem(job);
    if (produced) items.push(produced);
  }

  return { items, totals: sumTotals(jobs) };
}
